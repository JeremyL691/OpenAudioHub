#!/usr/bin/env node
// Bundles the Electron main process into desktop/build/main/main.cjs (CommonJS, Electron's Node).
// `electron` stays external: the runtime provides it.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const outdir = join(desktopRoot, "build", "main");
mkdirSync(outdir, { recursive: true });

await build({
    entryPoints: [join(desktopRoot, "src", "main", "index.ts")],
    // .cjs: desktop/package.json is "type": "module", and Electron must load this bundle as CommonJS.
    outfile: join(outdir, "main.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["electron"],
    sourcemap: "linked",
    logLevel: "warning",
});

// Development layout: the packaged app keeps ffmpeg in Resources/bin, so mirror it under build/bin
// for runs from desktop/build (bundleRootFor in index.ts).
const ffmpegBin = join(desktopRoot, "build", "ffmpeg", "bin");
if (existsSync(ffmpegBin)) {
    cpSync(ffmpegBin, join(desktopRoot, "build", "bin"), { recursive: true });
}

console.log(`built ${join(outdir, "main.cjs")}`);
