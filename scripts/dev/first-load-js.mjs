#!/usr/bin/env node
// Approximates Next.js "First Load JS" per App Router page from a finished build.
// Turbopack builds do not print sizes, so this reads the client reference
// manifests: per-page entry chunks, plus root and polyfill chunks shared by all
// pages. Sizes are gzip bytes of unique files, matching Next's definition.
// Usage: node scripts/dev/first-load-js.mjs [--json]

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { gzipSync } from "node:zlib";

const NEXT_DIR = ".next";
const APP_DIR = join(NEXT_DIR, "server", "app");
const MANIFEST_SUFFIX = "page_client-reference-manifest.js";

function walk(dir) {
    const out = [];
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) out.push(...walk(full));
        else if (full.endsWith(MANIFEST_SUFFIX)) out.push(full);
    }
    return out;
}

function parseManifest(file) {
    const text = readFileSync(file, "utf8");
    const assignment = text.match(/__RSC_MANIFEST\["[^"]*"\]\s*=\s*/);
    const start = assignment.index + assignment[0].length;
    const end = text.lastIndexOf("}");
    return JSON.parse(text.slice(start, end + 1));
}

function routeFromFile(file) {
    const rel = relative(APP_DIR, file).split(sep).join("/");
    const dir = rel.endsWith(MANIFEST_SUFFIX)
        ? rel.slice(0, -MANIFEST_SUFFIX.length)
        : rel;
    const segments = dir
        .split("/")
        .filter((s) => s !== "" && s !== "page" && !/^\(.*\)$/.test(s));
    return `/${segments.join("/")}`;
}

const buildManifest = JSON.parse(
    readFileSync(join(NEXT_DIR, "build-manifest.json"), "utf8"),
);
const sharedFiles = [
    ...(buildManifest.rootMainFiles ?? []),
    ...(buildManifest.polyfillFiles ?? []),
];

function gzipSize(file) {
    return gzipSync(readFileSync(join(NEXT_DIR, file))).length;
}

const rows = [];
for (const file of walk(APP_DIR)) {
    const manifest = parseManifest(file);
    const entries = Object.values(manifest.entryJSFiles ?? {}).flat();
    const unique = [...new Set([...sharedFiles, ...entries])];
    const bytes = unique.reduce((sum, chunk) => sum + gzipSize(chunk), 0);
    rows.push({
        route: routeFromFile(file),
        files: unique.length,
        gzipBytes: bytes,
    });
}
rows.sort((a, b) => a.route.localeCompare(b.route));

if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
} else {
    process.stdout.write(
        "| Route | Files | First Load JS (gzip KB) |\n|---|---:|---:|\n",
    );
    for (const r of rows) {
        process.stdout.write(
            `| ${r.route} | ${r.files} | ${(r.gzipBytes / 1024).toFixed(1)} |\n`,
        );
    }
}
