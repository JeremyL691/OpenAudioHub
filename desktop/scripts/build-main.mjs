#!/usr/bin/env node
// Bundles the Electron main process into desktop/build/main/main.js (CommonJS, Electron's Node).
// `electron` stays external: the runtime provides it.
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const outdir = join(desktopRoot, "build", "main");
mkdirSync(outdir, { recursive: true });

await build({
    entryPoints: [join(desktopRoot, "src", "main", "index.ts")],
    outfile: join(outdir, "main.js"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["electron"],
    sourcemap: "linked",
    logLevel: "warning",
});

console.log(`built ${join(outdir, "main.js")}`);
