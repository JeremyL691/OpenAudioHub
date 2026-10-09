#!/usr/bin/env node
// Builds the macOS app (PLAN T14.1): the web app, the staged runtime, the main bundle, the notices, and then
// electron-builder with electron-builder.yml. The packaging output goes to ~/Library/Caches/OpenAudioHub/dist,
// outside the File Provider-synced ~/Desktop (D-342). The DMG is then copied to desktop/dist and its sha256
// is printed. Pass --skip-web to reuse the existing .next/standalone build.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "..");
const skipWeb = process.argv.includes("--skip-web");
// The test build (--test-fuses) enables the NODE_OPTIONS and CLI inspection fuses, which Playwright's _electron
// needs to attach (the release set turns them off). It is written to its own folder and never published (D-351).
const testFuses = process.argv.includes("--test-fuses");
const outputRoot = join(
    homedir(),
    "Library",
    "Caches",
    "OpenAudioHub",
    testFuses ? "dist-test" : "dist",
);

function run(command, args, options = {}) {
    console.log(`$ ${command} ${args.join(" ")}`);
    const result = spawnSync(command, args, { stdio: "inherit", ...options });
    if (result.status !== 0) {
        throw new Error(`${basename(command)} exited with ${result.status}`);
    }
}

const rootVersion = JSON.parse(
    readFileSync(join(repoRoot, "package.json"), "utf8"),
).version;
const build = join(desktopRoot, "build");

if (!skipWeb) run("pnpm", ["-C", repoRoot, "build"]);
run("node", [join(desktopRoot, "scripts", "stage-server.mjs")]);
run("node", [join(desktopRoot, "scripts", "stage-postgres.mjs")]);
run("node", [join(desktopRoot, "scripts", "stage-python.mjs")]);
run("bash", [join(desktopRoot, "scripts", "build-ffmpeg.sh")]);
run("node", [join(desktopRoot, "scripts", "build-main.mjs")]);
run("node", [join(desktopRoot, "scripts", "third-party-notices.mjs")]);

// The inputs electron-builder.yml maps into the app bundle.
const required = [
    "postgres/bin/postgres",
    "python/bin/python3",
    "audio-pipeline/src",
    "pipeline-launcher.py",
    "server/server-desktop.js",
    "bin/ffmpeg",
    "tray/trayTemplate.png",
    "THIRD_PARTY_NOTICES.md",
    "licenses",
    "main/main.cjs",
];
for (const path of required) {
    if (!existsSync(join(build, path))) {
        throw new Error(`missing staged input: desktop/build/${path}`);
    }
}

/** Builds build/icon.icns from the brand mark with sips and iconutil (macOS tools, no download). */
function makeIcon() {
    const source = join(repoRoot, "brand", "source", "app-icon.png");
    const iconset = join(build, "icon.iconset");
    rmSync(iconset, { recursive: true, force: true });
    mkdirSync(iconset, { recursive: true });
    for (const size of [16, 32, 128, 256, 512]) {
        const double = size * 2;
        run(
            "sips",
            [
                "-z",
                String(size),
                String(size),
                source,
                "--out",
                join(iconset, `icon_${size}x${size}.png`),
            ],
            { stdio: "ignore" },
        );
        run(
            "sips",
            [
                "-z",
                String(double),
                String(double),
                source,
                "--out",
                join(iconset, `icon_${size}x${size}@2x.png`),
            ],
            { stdio: "ignore" },
        );
    }
    run("iconutil", ["-c", "icns", iconset, "-o", join(build, "icon.icns")]);
    rmSync(iconset, { recursive: true, force: true });
}

makeIcon();
mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
run(
    join(desktopRoot, "node_modules", ".bin", "electron-builder"),
    [
        "--mac",
        "dmg",
        "--arm64",
        "--publish",
        "never",
        "--config",
        join(desktopRoot, "electron-builder.yml"),
        `--config.directories.output=${outputRoot}`,
        `--config.extraMetadata.version=${rootVersion}`,
        // The Electron build the postinstall step fetched and checked against checksums.json (PLAN §18).
        `--config.electronDist=${join(desktopRoot, "node_modules", "electron", "dist")}`,
        ...(testFuses
            ? [
                  "--config.electronFuses.enableNodeOptionsEnvironmentVariable=true",
                  "--config.electronFuses.enableNodeCliInspectArguments=true",
              ]
            : []),
    ],
    { cwd: desktopRoot },
);

const dmg = join(outputRoot, `OpenAudioHub-${rootVersion}-arm64.dmg`);
if (!existsSync(dmg)) throw new Error(`expected DMG not found: ${dmg}`);
if (testFuses) {
    console.log(
        `test build (not for distribution): ${join(outputRoot, "mac-arm64", "OpenAudioHub.app")}`,
    );
} else {
    const copy = join(desktopRoot, "dist", basename(dmg));
    mkdirSync(dirname(copy), { recursive: true });
    copyFileSync(dmg, copy);
    const digest = createHash("sha256").update(readFileSync(dmg)).digest("hex");
    console.log(`DMG: ${copy}`);
    console.log(`sha256: ${digest}`);
}
