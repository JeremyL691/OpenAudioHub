#!/usr/bin/env node
// Bundles the Electron main process into desktop/build/main/main.cjs (CommonJS, Electron's Node).
// `electron` stays external: the runtime provides it.
import {
    cpSync,
    existsSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
} from "node:fs";
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

// The sandboxed preload for the app window (preload.cjs sits next to main.cjs).
await build({
    entryPoints: [join(desktopRoot, "src", "preload", "connector.ts")],
    outfile: join(outdir, "preload.cjs"),
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
// The menu-bar icons live in Resources/tray in the packaged app (tray.ts).
cpSync(
    join(desktopRoot, "resources", "tray"),
    join(desktopRoot, "build", "tray"),
    { recursive: true },
);
// app.getVersion() reads the package.json next to the entry. The version comes from the root package.json
// (D-312), so the development build reports the same version as the packaged app.
const rootPackage = JSON.parse(
    readFileSync(join(desktopRoot, "..", "package.json"), "utf8"),
);
writeFileSync(
    join(outdir, "package.json"),
    `${JSON.stringify(
        {
            name: "openaudiohub",
            productName: "OpenAudioHub",
            version: rootPackage.version,
            main: "main.cjs",
        },
        null,
        2,
    )}\n`,
);

console.log(`built ${join(outdir, "main.cjs")}`);
