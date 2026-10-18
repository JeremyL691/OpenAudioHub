// Builds the browser extension: bundles the TypeScript sources with esbuild, copies the static
// files, writes the manifest, and can produce a test build or the release zip.
//
//   node build.mjs           release build in dist/
//   node build.mjs --test    test build in dist-test/
//   node build.mjs --zip     release build, then dist-zip/OpenAudioHub_Extension_<version>.zip

import { build } from "esbuild";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const root = dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const test = args.has("--test");
const zip = args.has("--zip");
const outdir = join(root, test ? "dist-test" : "dist");
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

const testApiBase = process.env.OAH_TEST_API_BASE ?? "http://127.0.0.1:3298";
const define = {
    __OAH_TEST__: test ? "true" : "false",
    __OAH_TEST_API_BASE__: JSON.stringify(testApiBase),
};

async function copyStatic() {
    await cp(join(root, "static"), outdir, { recursive: true });
    const manifest = JSON.parse(await readFile(join(root, "static/manifest.json"), "utf8"));
    manifest.version = packageJson.version;
    if (test) {
        manifest.host_permissions = [...manifest.host_permissions, "http://127.0.0.1/*"];
    }
    await writeFile(join(outdir, "manifest.json"), `${JSON.stringify(manifest, null, 4)}\n`);
}

async function bundle() {
    const shared = {
        bundle: true,
        platform: "browser",
        target: "chrome120",
        define,
        legalComments: "none",
        logLevel: "warning",
        minify: !test,
    };
    await build({
        ...shared,
        entryPoints: [join(root, "src/worker.ts")],
        outfile: join(outdir, "worker.js"),
        format: "esm",
    });
    await build({
        ...shared,
        entryPoints: [join(root, "src/popup.ts")],
        outfile: join(outdir, "popup.js"),
        format: "iife",
    });
}

async function filesUnder(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) files.push(...(await filesUnder(path)));
        else files.push(path);
    }
    return files;
}

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(data) {
    let crc = 0xffffffff;
    for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time, day };
}

/** Writes a zip whose entries are the files under `dir`, with paths relative to it. */
async function writeZip(dir, outFile) {
    const files = (await filesUnder(dir)).sort();
    const chunks = [];
    const central = [];
    const now = new Date();
    const { time, day } = dosDateTime(now);
    let offset = 0;

    for (const file of files) {
        const name = Buffer.from(relative(dir, file).split(sep).join("/"), "utf8");
        const data = await readFile(file);
        const compressed = deflateRawSync(data);
        const stored = compressed.length >= data.length;
        const payload = stored ? data : compressed;
        const method = stored ? 0 : 8;
        const checksum = crc32(data);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6);
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(time, 10);
        local.writeUInt16LE(day, 12);
        local.writeUInt32LE(checksum, 14);
        local.writeUInt32LE(payload.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);
        chunks.push(local, name, payload);

        central.push({ name, checksum, compressed: payload.length, size: data.length, method, offset });
        offset += local.length + name.length + payload.length;
    }

    const centralStart = offset;
    for (const entry of central) {
        const header = Buffer.alloc(46);
        header.writeUInt32LE(0x02014b50, 0);
        header.writeUInt16LE(20, 4);
        header.writeUInt16LE(20, 6);
        header.writeUInt16LE(0x0800, 8);
        header.writeUInt16LE(entry.method, 10);
        header.writeUInt16LE(time, 12);
        header.writeUInt16LE(day, 14);
        header.writeUInt32LE(entry.checksum, 16);
        header.writeUInt32LE(entry.compressed, 20);
        header.writeUInt32LE(entry.size, 24);
        header.writeUInt16LE(entry.name.length, 28);
        header.writeUInt16LE(0, 30);
        header.writeUInt16LE(0, 32);
        header.writeUInt16LE(0, 34);
        header.writeUInt16LE(0, 36);
        header.writeUInt32LE(0, 38);
        header.writeUInt32LE(entry.offset, 42);
        chunks.push(header, entry.name);
        offset += header.length + entry.name.length;
    }

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(central.length, 8);
    end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(offset - centralStart, 12);
    end.writeUInt32LE(centralStart, 16);
    end.writeUInt16LE(0, 20);
    chunks.push(end);

    await writeFile(outFile, Buffer.concat(chunks));
}

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await copyStatic();
await bundle();

if (!test) {
    const hits = (await filesUnder(outdir)).filter((file) => file.endsWith(".js"));
    for (const file of hits) {
        if ((await readFile(file, "utf8")).includes("OAH_TEST")) {
            throw new Error(`test code found in ${relative(root, file)}`);
        }
    }
}

if (zip) {
    const zipDir = join(root, "dist-zip");
    await mkdir(zipDir, { recursive: true });
    const outFile = join(zipDir, `OpenAudioHub_Extension_${packageJson.version}.zip`);
    await writeZip(outdir, outFile);
    const size = (await stat(outFile)).size;
    console.log(`zipped ${relative(root, outFile)} (${size} bytes)`);
} else {
    console.log(`built ${relative(root, outdir)}`);
}
