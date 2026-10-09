#!/usr/bin/env node
// Stages the audio pipeline's Python runtime into desktop/build (PLAN T12.4, D-307).
//   build/python                 python-build-standalone 3.12 (pinned), arm64, with the locked dependencies
//   build/audio-pipeline/src     the repository's audio-pipeline source (unchanged)
//   build/audio-pipeline/models  the bundled VAD model
//   build/pipeline-launcher.py   desktop launcher (resources/pipeline-launcher.py)
// Dependencies come from `uv export --frozen --no-dev` and are installed with --require-hashes.
import { execFileSync } from "node:child_process";
import {
    copyFileSync,
    cpSync,
    existsSync,
    mkdirSync,
    readdirSync,
    rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchPinned } from "./lib/download.mjs";
import { PINS } from "./lib/pins.mjs";

const UV_VERSION = "0.12.23"; // same uv as the Docker image (audio-pipeline/Dockerfile)

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "..");
const cacheRoot = join(desktopRoot, ".cache");
const workRoot = join(cacheRoot, "work", "python");
const out = join(desktopRoot, "build");
const pythonOut = join(out, "python");
const pipelineRepo = join(repoRoot, "audio-pipeline");

function run(cmd, args, options = {}) {
    return execFileSync(cmd, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        ...options,
    });
}

function hasValidSignature(file) {
    try {
        run("codesign", ["--verify", "--strict", file], {
            stdio: ["ignore", "pipe", "pipe"],
        });
        return true;
    } catch {
        return false;
    }
}

const uvVersion = run("uv", ["--version"]).trim();
if (!uvVersion.startsWith(`uv ${UV_VERSION} `)) {
    throw new Error(`uv ${UV_VERSION} is required, found: ${uvVersion}`);
}

// 1. Pinned interpreter.
const archive = await fetchPinned(
    join(cacheRoot, "downloads"),
    PINS.pythonStandalone,
);
rmSync(workRoot, { recursive: true, force: true });
mkdirSync(workRoot, { recursive: true });
run("tar", ["-xzf", archive, "-C", workRoot]);
rmSync(pythonOut, { recursive: true, force: true });
run("mv", [join(workRoot, "python"), pythonOut]);
const python = join(pythonOut, "bin", "python3");
const version = run(python, [
    "-I",
    "-B",
    "-c",
    "import sys; print('%d.%d.%d' % sys.version_info[:3])",
]).trim();
if (version !== PINS.pythonStandalone.version) {
    throw new Error(
        `expected Python ${PINS.pythonStandalone.version}, found ${version}`,
    );
}

// 2. Locked, hashed requirements of the pipeline (no project install; the pipeline runs from its source tree).
const requirements = join(workRoot, "requirements.txt");
run(
    "uv",
    [
        "export",
        "--frozen",
        "--no-dev",
        "--no-emit-project",
        "--format",
        "requirements-txt",
        "-o",
        requirements,
    ],
    {
        cwd: pipelineRepo,
    },
);
run(
    "uv",
    [
        "pip",
        "install",
        "--python",
        python,
        "--require-hashes",
        "--no-deps",
        "-r",
        requirements,
    ],
    {
        stdio: "inherit",
    },
);

// 3. Trim what the pipeline never imports (PLAN T12.4: tk, idle, test) and headers and man pages.
const libDir = join(pythonOut, "lib");
const stdlib = readdirSync(libDir).find((name) => /^python3\.\d+$/.test(name));
const trimmed = [
    join(libDir, stdlib, "tkinter"),
    join(libDir, stdlib, "idlelib"),
    join(libDir, stdlib, "turtledemo"),
    join(libDir, stdlib, "test"),
    join(pythonOut, "include"),
    join(pythonOut, "share"),
];
for (const path of trimmed) rmSync(path, { recursive: true, force: true });
for (const entry of readdirSync(libDir)) {
    if (/^(tcl|tk|itcl|thread|Tk|tcl\d)/i.test(entry))
        rmSync(join(libDir, entry), { recursive: true, force: true });
}

// 4. Bytecode compiled at staging time with unchecked-hash, so the runtime never writes .pyc files (-B).
run(python, [
    "-I",
    "-B",
    "-m",
    "compileall",
    "-q",
    "--invalidation-mode",
    "unchecked-hash",
    join(libDir, stdlib),
    join(libDir, stdlib, "site-packages"),
]);

// 5. Pipeline source and model, and the launcher.
const pipelineOut = join(out, "audio-pipeline");
rmSync(pipelineOut, { recursive: true, force: true });
mkdirSync(pipelineOut, { recursive: true });
cpSync(join(pipelineRepo, "src"), join(pipelineOut, "src"), {
    recursive: true,
    filter: (src) => !src.includes("__pycache__"),
});
cpSync(join(pipelineRepo, "models"), join(pipelineOut, "models"), {
    recursive: true,
});
copyFileSync(
    join(desktopRoot, "resources", "pipeline-launcher.py"),
    join(out, "pipeline-launcher.py"),
);

// 6. Ad-hoc signature on every Mach-O file that does not verify. Some PyPI wheels ship unsigned universal
//    binaries (protobuf's _message, uvloop's loop); the bundle's nested-code check (gatekeeper-check.sh,
//    T10.6) requires every Mach-O file to verify. Files that already verify are left alone.
const machOFiles = run(
    "sh",
    [
        "-c",
        `find "$1" -type f -exec file {} + | grep 'Mach-O' | sed -e 's/ (for architecture [^)]*)//' | cut -d: -f1 | sort -u`,
        "sh",
        pythonOut,
    ],
    { maxBuffer: 64 * 1024 * 1024 },
)
    .split("\n")
    .filter(Boolean);
let resigned = 0;
for (const file of machOFiles) {
    if (hasValidSignature(file)) continue;
    run("xattr", ["-c", file]);
    run("codesign", ["--force", "--sign", "-", file]);
    resigned += 1;
}
console.log(
    `Mach-O files: ${machOFiles.length}; ad-hoc signed ${resigned} that did not verify`,
);

const sitePackages = join(libDir, stdlib, "site-packages");
const packageCount = existsSync(sitePackages)
    ? readdirSync(sitePackages).length
    : 0;
const size = run("du", ["-sh", pythonOut]).split("\t")[0];
console.log(
    `staged Python ${version} with ${packageCount} site-packages entries (${size}) at ${pythonOut}`,
);
console.log(
    `pipeline source and model at ${pipelineOut}; launcher at ${join(out, "pipeline-launcher.py")}`,
);
