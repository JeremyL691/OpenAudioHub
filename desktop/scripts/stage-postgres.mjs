#!/usr/bin/env node
// Stages PostgreSQL 16 (EDB binaries, pinned in lib/pins.mjs) into desktop/build/postgres (PLAN T12.3, D-306).
//
// Pruning rules (verified in the T10.1 spike, see docs/dev/DESKTOP_SPIKE.md):
//   - Mach-O roots: bin/{postgres, initdb, pg_ctl, pg_dump, pg_restore, pg_isready}; psql is not shipped.
//   - Dynamic closure of the roots, resolved through @rpath and @loader_path (EDB uses @loader_path/../lib).
//   - Extension modules: lib/postgresql/{plpgsql, dict_snowball}.dylib (initdb creates both).
//   - share/postgresql without the contrib extension scripts, except plpgsql.
//   - Dropped: pgAdmin, StackBuilder, doc, include, share/man.
//   - Every Mach-O is thinned to arm64 and re-signed ad hoc (no hardened runtime, D-303).
import { execFileSync, spawnSync } from "node:child_process";
import {
    chmodSync,
    copyFileSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readlinkSync,
    rmSync,
    statSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchPinned } from "./lib/download.mjs";
import { PINS } from "./lib/pins.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const cacheRoot = join(desktopRoot, ".cache");
const workRoot = join(cacheRoot, "work", "postgres");
const out = join(desktopRoot, "build", "postgres");

const ROOT_BINARIES = [
    "postgres",
    "initdb",
    "pg_ctl",
    "pg_dump",
    "pg_restore",
    "pg_isready",
];
const EXTENSION_MODULES = ["plpgsql", "dict_snowball"];
const KEEP_EXTENSION_FILES = /^(plpgsql)/;

function run(cmd, args, options = {}) {
    return execFileSync(cmd, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        ...options,
    });
}

function isMachO(path) {
    try {
        const info = run("file", ["-b", path]);
        return info.includes("Mach-O");
    } catch {
        return false;
    }
}

/** Install names from `otool -L` (first line is the file itself). */
function linkedNames(path) {
    const lines = run("otool", ["-L", path]).split("\n").slice(1);
    return lines
        .map((line) => line.trim().match(/^(\S+) \(compatibility version/))
        .filter(Boolean)
        .map((m) => m[1]);
}

function isAllowedExternal(name) {
    return name.startsWith("/usr/lib/") || name.startsWith("/System/Library/");
}

/** Resolves an install name inside the EDB tree, or returns null for system libraries. */
function resolveInTree(name, sourceRoot) {
    if (isAllowedExternal(name)) return null;
    const base = name.split("/").pop();
    for (const candidate of [
        join(sourceRoot, "lib", base),
        join(sourceRoot, "lib", "postgresql", base),
    ]) {
        if (existsSync(candidate)) return candidate;
    }
    throw new Error(`unresolved dependency ${name}`);
}

function closure(sourceRoot, roots) {
    const seen = new Map(); // relative path -> absolute path
    const queue = [...roots];
    while (queue.length > 0) {
        const current = queue.shift();
        const rel = relative(sourceRoot, current);
        if (seen.has(rel)) continue;
        seen.set(rel, current);
        for (const name of linkedNames(current)) {
            if (
                name.startsWith("@rpath/") ||
                name.startsWith("@loader_path/")
            ) {
                const target = resolveInTree(name, sourceRoot);
                if (target) queue.push(target);
            } else if (!isAllowedExternal(name)) {
                throw new Error(`external dependency ${name} in ${rel}`);
            }
        }
    }
    return seen;
}

function copyTree(src, dst) {
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
}

function thinAndSign(path) {
    const info = run("lipo", ["-info", path]);
    if (info.includes("Architectures in the fat file")) {
        const tmp = `${path}.arm64`;
        run("lipo", ["-thin", "arm64", path, "-output", tmp]);
        copyFileSync(tmp, path);
        rmSync(tmp);
    }
    run("codesign", ["--force", "--sign", "-", path]);
}

// 1. Pinned download and extraction.
const zip = await fetchPinned(join(cacheRoot, "downloads"), PINS.postgres);
const source = join(workRoot, "pgsql");
rmSync(workRoot, { recursive: true, force: true });
mkdirSync(workRoot, { recursive: true });
run("unzip", ["-q", zip, "-d", workRoot]);
if (!existsSync(join(source, "bin", "postgres"))) {
    throw new Error("unexpected archive layout: pgsql/bin/postgres missing");
}

// 2. Signer check on the upstream universal binary (before thinning removes the signature).
const signingResult = spawnSync(
    "codesign",
    ["-dvvv", join(source, "bin", "postgres")],
    { encoding: "utf8" },
);
const signing = `${signingResult.stdout}${signingResult.stderr}`; // codesign writes its details to stderr
if (!signing.includes(`TeamIdentifier=${PINS.postgres.teamId}`)) {
    throw new Error(`postgres is not signed by team ${PINS.postgres.teamId}`);
}

// 3. Closure and copy.
const rootFiles = ROOT_BINARIES.map((name) => join(source, "bin", name));
const extensionFiles = EXTENSION_MODULES.map((name) =>
    join(source, "lib", "postgresql", `${name}.dylib`),
);
rmSync(out, { recursive: true, force: true });
const files = closure(source, [...rootFiles, ...extensionFiles]);
for (const [rel, abs] of files) {
    copyTree(abs, join(out, rel));
}

// 4. share/postgresql: everything except contrib extension scripts (keep plpgsql, which initdb needs).
const shareSrc = join(source, "share", "postgresql");
const shareDst = join(out, "share", "postgresql");
mkdirSync(shareDst, { recursive: true });
run("cp", ["-R", `${shareSrc}/.`, shareDst]);
const extDir = join(shareDst, "extension");
if (existsSync(extDir)) {
    for (const entry of readdirSync(extDir)) {
        if (!KEEP_EXTENSION_FILES.test(entry))
            rmSync(join(extDir, entry), { force: true });
    }
}

// 5. Thin to arm64 and sign ad hoc.
for (const rel of files.keys()) {
    const path = join(out, rel);
    if (isMachO(path)) thinAndSign(path);
}

// 6. Checks: arm64 only, no external install names, every symlink resolves inside the tree.
for (const rel of files.keys()) {
    const path = join(out, rel);
    if (!isMachO(path)) continue;
    if (!run("lipo", ["-info", path]).includes("arm64"))
        throw new Error(`not arm64: ${rel}`);
    for (const name of linkedNames(path)) {
        if (
            !(
                name.startsWith("@rpath/") ||
                name.startsWith("@loader_path/") ||
                isAllowedExternal(name)
            )
        ) {
            throw new Error(`external install name ${name} in ${rel}`);
        }
    }
}
for (const entry of walk(out)) {
    if (lstatSync(entry).isSymbolicLink()) {
        const target = join(dirname(entry), readlinkSync(entry));
        if (!existsSync(target))
            throw new Error(`broken symlink ${relative(out, entry)}`);
    }
}
for (const bin of ROOT_BINARIES) {
    chmodSync(join(out, "bin", bin), 0o755);
}

function* walk(dir) {
    for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        yield path;
        if (
            statSync(path, { throwIfNoEntry: false })?.isDirectory() &&
            !lstatSync(path).isSymbolicLink()
        ) {
            yield* walk(path);
        }
    }
}

console.log(
    `staged PostgreSQL ${PINS.postgres.version} (${files.size} Mach-O and data files) at ${out}`,
);
console.log(`size: ${run("du", ["-sh", out]).split("\t")[0]}`);
