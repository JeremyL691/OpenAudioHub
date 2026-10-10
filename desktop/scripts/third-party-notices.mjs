#!/usr/bin/env node
// Writes desktop/build/THIRD_PARTY_NOTICES.md and desktop/build/licenses/ (PLAN T12.6).
// Inventory sources:
//   - native components: the pinned upstream archives (license files taken from the archives themselves)
//   - Python packages: *.dist-info metadata in build/python
//   - Node packages: package.json files under build/server/node_modules
// The script fails when a packaged component has no entry, so a new dependency cannot ship unnoticed.
import { execFileSync } from "node:child_process";
import {
    copyFileSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PINS } from "./lib/pins.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "..");
const build = join(desktopRoot, "build");
const licensesOut = join(build, "licenses");
const downloads = join(desktopRoot, ".cache", "downloads");
const work = join(desktopRoot, ".cache", "work", "notices");

rmSync(licensesOut, { recursive: true, force: true });
mkdirSync(licensesOut, { recursive: true });
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

const components = []; // { group, name, version, license, files: [relative paths under licenses/] }

function copyInto(dir, srcPath, name = basename(srcPath)) {
    mkdirSync(join(licensesOut, dir), { recursive: true });
    const rel = join(dir, name);
    copyFileSync(srcPath, join(licensesOut, rel));
    return rel;
}

function extractFromArchive(archive, member, destDir) {
    mkdirSync(destDir, { recursive: true });
    execFileSync(
        "tar",
        archive.endsWith(".xz")
            ? ["-xJf", archive, "-C", destDir, member]
            : ["-xzf", archive, "-C", destDir, member],
    );
    return join(destDir, member);
}

// ---- native components -------------------------------------------------------------------------
{
    const zip = join(downloads, PINS.postgres.file);
    if (!existsSync(zip))
        throw new Error(`missing ${zip}; run stage-postgres first`);
    const dir = join(licensesOut, "postgres");
    mkdirSync(dir, { recursive: true });
    for (const member of [
        "pgsql/server_license.txt",
        "pgsql/commandlinetools_3rd_party_licenses.txt",
    ]) {
        const text = execFileSync("unzip", ["-p", zip, member], {
            maxBuffer: 1 << 26,
        });
        writeFileSync(join(dir, basename(member)), text);
    }
    components.push({
        group: "native",
        name: "PostgreSQL (EDB binaries) with bundled third-party libraries",
        version: PINS.postgres.version,
        license:
            "PostgreSQL License; third-party licenses listed in the bundled file",
        files: [
            "postgres/server_license.txt",
            "postgres/commandlinetools_3rd_party_licenses.txt",
        ],
        matches: ["postgres"],
    });
}

{
    const electronLicense = join(
        desktopRoot,
        "node_modules",
        "electron",
        "dist",
        "LICENSE",
    );
    const chromium = join(
        desktopRoot,
        "node_modules",
        "electron",
        "dist",
        "LICENSES.chromium.html",
    );
    if (!existsSync(electronLicense))
        throw new Error(
            "electron dist is missing; run pnpm install in desktop/",
        );
    components.push({
        group: "native",
        name: "Electron (Chromium, Node.js, V8 and other bundled components)",
        version: PINS.electron.version,
        license:
            "MIT; Chromium and other components per LICENSES.chromium.html",
        files: [
            copyInto("electron", electronLicense),
            copyInto("electron", chromium),
        ],
        matches: ["electron"],
    });
}

{
    const pyLicense = join(build, "python", "lib", "python3.12", "LICENSE.txt");
    if (!existsSync(pyLicense))
        throw new Error("missing python LICENSE.txt; run stage-python first");
    components.push({
        group: "native",
        name: "CPython (python-build-standalone build)",
        version: PINS.pythonStandalone.version,
        license: "Python Software Foundation License Version 2",
        files: [copyInto("python", pyLicense)],
        matches: ["python"],
    });
}

{
    const archive = join(downloads, PINS.ffmpeg.file);
    const copying = extractFromArchive(
        archive,
        `ffmpeg-${PINS.ffmpeg.version}/COPYING.LGPLv2.1`,
        join(work, "ffmpeg"),
    );
    components.push({
        group: "native",
        name: "FFmpeg (ffmpeg and ffprobe, LGPL build without --enable-gpl or --enable-nonfree)",
        version: PINS.ffmpeg.version,
        license: "LGPL-2.1-or-later",
        files: [
            copyInto("ffmpeg", copying, "COPYING.LGPLv2.1"),
            "ffmpeg/source-offer.txt",
        ],
        matches: ["ffmpeg"],
    });
    writeFileSync(
        join(licensesOut, "ffmpeg", "source-offer.txt"),
        `Corresponding source for FFmpeg ${PINS.ffmpeg.version}, libopus ${PINS.opus.version} and LAME ${PINS.lame.version}\n` +
            `is distributed with this release under build/ffmpeg/source (archives verified by sha256 in desktop/scripts/lib/pins.mjs).\n` +
            `The build script is desktop/scripts/build-ffmpeg.sh.\n`,
    );
}

{
    const archive = join(downloads, PINS.opus.file);
    const copying = extractFromArchive(
        archive,
        `opus-${PINS.opus.version}/COPYING`,
        join(work, "opus"),
    );
    components.push({
        group: "native",
        name: "libopus (static, linked into ffmpeg)",
        version: PINS.opus.version,
        license: "BSD-3-Clause",
        files: [copyInto("opus", copying, "COPYING")],
        matches: ["ffmpeg"],
    });
}

{
    const archive = join(downloads, PINS.lame.file);
    const copying = extractFromArchive(
        archive,
        `lame-${PINS.lame.version}/COPYING`,
        join(work, "lame"),
    );
    components.push({
        group: "native",
        name: "LAME MP3 encoder (static, linked into ffmpeg)",
        version: PINS.lame.version,
        license: "LGPL-2.0-or-later",
        files: [copyInto("lame", copying, "COPYING")],
        matches: ["ffmpeg"],
    });
}

{
    // The license ships next to the model (audio-pipeline/models). A missing file is an error: an optional lookup
    // once pointed at the wrong name and left the notice without its license text.
    const silero = join(
        repoRoot,
        "audio-pipeline",
        "models",
        "SILERO_LICENSE.txt",
    );
    if (!existsSync(silero))
        throw new Error(`missing Silero VAD license: ${silero}`);
    const files = [copyInto("silero-vad", silero, "LICENSE")];
    components.push({
        group: "native",
        name: "Silero VAD model (audio-pipeline/models/silero_vad.onnx)",
        version: "as bundled",
        license: "MIT (upstream Silero VAD project)",
        files,
        matches: ["audio-pipeline"],
    });
}

// ---- Python packages ---------------------------------------------------------------------------
function parseHeaders(text) {
    const headers = {};
    let last = null;
    for (const line of text.split("\n")) {
        if (line.trim() === "") break;
        const match = /^([A-Za-z-]+):\s?(.*)$/.exec(line);
        if (match && !line.startsWith(" ")) {
            last = match[1].toLowerCase();
            if (!(last in headers)) headers[last] = match[2].trim();
        } else if (last && line.startsWith(" ")) {
            headers[last] += ` ${line.trim()}`;
        }
    }
    return headers;
}

const sitePackages = join(
    build,
    "python",
    "lib",
    "python3.12",
    "site-packages",
);
if (!existsSync(sitePackages))
    throw new Error("missing site-packages; run stage-python first");
const pythonEntries = [];
for (const entry of readdirSync(sitePackages)
    .filter((n) => n.endsWith(".dist-info"))
    .sort()) {
    const dir = join(sitePackages, entry);
    const headers = parseHeaders(readFileSync(join(dir, "METADATA"), "utf8"));
    const classifiers = readFileSync(join(dir, "METADATA"), "utf8")
        .split("\n")
        .filter((l) => l.startsWith("Classifier: License ::"))
        .map((l) => l.replace("Classifier: License :: ", "").trim());
    const license =
        headers["license-expression"] ||
        headers.license ||
        classifiers.join("; ") ||
        "UNKNOWN";
    const licenseFiles = [];
    const licenseDirs = [dir, join(dir, "licenses")];
    for (const d of licenseDirs) {
        if (!existsSync(d) || !statSync(d).isDirectory()) continue;
        for (const f of readdirSync(d)) {
            if (
                /^(LICEN[SC]E|COPYING|NOTICE)/i.test(f) &&
                statSync(join(d, f)).isFile()
            ) {
                licenseFiles.push(
                    copyInto(
                        join("python", `${headers.name}-${headers.version}`),
                        join(d, f),
                        f,
                    ),
                );
            }
        }
    }
    pythonEntries.push({
        name: headers.name,
        version: headers.version,
        license,
        files: licenseFiles,
    });
}

// ---- Node packages (Next.js standalone output) -------------------------------------------------
const nodeModules = join(build, "server", "node_modules");
const nodeEntries = [];
function collectPackageDirs(root) {
    const found = new Map(); // realpath -> directory
    const stack = [root];
    while (stack.length > 0) {
        const dir = stack.pop();
        const real = realpathSync(dir);
        if (found.has(real)) continue;
        found.set(real, dir);
        for (const name of readdirSync(dir)) {
            if (name === ".bin" || name === ".cache") continue;
            const path = join(dir, name);
            if (
                !lstatSync(path).isDirectory() &&
                !lstatSync(path).isSymbolicLink()
            )
                continue;
            if (
                name.startsWith("@") ||
                name === "node_modules" ||
                name === ".pnpm" ||
                dir.endsWith("node_modules") ||
                dir.endsWith(".pnpm")
            ) {
                stack.push(path);
            } else if (existsSync(join(path, "package.json"))) {
                stack.push(path);
            }
        }
    }
    return [...found.values()];
}

for (const dir of collectPackageDirs(nodeModules)) {
    const pkgJson = join(dir, "package.json");
    if (!existsSync(pkgJson)) continue;
    const pkg = JSON.parse(readFileSync(pkgJson, "utf8"));
    if (!pkg.name || !pkg.version) continue;
    let license = "UNKNOWN";
    if (typeof pkg.license === "string") license = pkg.license;
    else if (pkg.license && typeof pkg.license.type === "string")
        license = pkg.license.type;
    else if (Array.isArray(pkg.licenses))
        license = pkg.licenses.map((l) => l.type || l).join(" OR ");
    const files = [];
    for (const f of readdirSync(dir)) {
        if (
            /^(LICEN[SC]E|COPYING|NOTICE)/i.test(f) &&
            statSync(join(dir, f)).isFile()
        ) {
            files.push(
                copyInto(
                    join(
                        "node",
                        `${pkg.name}@${pkg.version}`.replace("/", "__"),
                    ),
                    join(dir, f),
                    f,
                ),
            );
        }
    }
    nodeEntries.push({ name: pkg.name, version: pkg.version, license, files });
}
const uniqueNode = [
    ...new Map(nodeEntries.map((e) => [`${e.name}@${e.version}`, e])).values(),
].sort((a, b) =>
    `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
);

// ---- completeness checks -----------------------------------------------------------------------
const problems = [];
for (const dir of ["postgres/bin", "postgres/lib"]) {
    if (!existsSync(join(build, dir))) problems.push(`missing ${dir}`);
}
for (const entry of pythonEntries) {
    if (!entry.name) problems.push("python dist-info without a Name");
    if (!entry.license || entry.license === "UNKNOWN")
        problems.push(`python ${entry.name}: license not declared`);
}
for (const entry of uniqueNode) {
    if (!entry.license || entry.license === "UNKNOWN")
        problems.push(
            `node ${entry.name}@${entry.version}: license not declared`,
        );
}
for (const component of components) {
    for (const file of component.files) {
        if (!file || !existsSync(join(licensesOut, file)))
            problems.push(`${component.name}: license file ${file} missing`);
    }
}

// ---- THIRD_PARTY_NOTICES.md --------------------------------------------------------------------
const lines = [];
lines.push("# Third-party notices", "");
lines.push(
    "OpenAudioHub (the app) is licensed under AGPL-3.0. This file lists the components bundled in the macOS app,",
    "with their licenses. License texts are in `licenses/` next to this file.",
    "",
);
lines.push(
    "## Native components",
    "",
    "| Component | Version | License | License files |",
    "| --- | --- | --- | --- |",
);
for (const c of components) {
    lines.push(
        `| ${c.name} | ${c.version} | ${c.license} | ${c.files.map((f) => `\`licenses/${f}\``).join(", ")} |`,
    );
}
lines.push(
    "",
    "## Python packages (audio pipeline)",
    "",
    "| Package | Version | License |",
    "| --- | --- | --- |",
);
for (const e of pythonEntries)
    lines.push(`| ${e.name} | ${e.version} | ${e.license} |`);
lines.push(
    "",
    "## Node packages (web server)",
    "",
    "| Package | Version | License |",
    "| --- | --- | --- |",
);
for (const e of uniqueNode)
    lines.push(`| ${e.name} | ${e.version} | ${e.license} |`);
lines.push("");
writeFileSync(join(build, "THIRD_PARTY_NOTICES.md"), lines.join("\n"));

if (problems.length > 0) {
    console.error(`third-party notices incomplete (${problems.length}):`);
    for (const p of problems.slice(0, 50)) console.error(`  - ${p}`);
    process.exit(1);
}
console.log(
    `THIRD_PARTY_NOTICES.md written: ${components.length} native, ${pythonEntries.length} Python, ${uniqueNode.length} Node packages`,
);
void relative;
