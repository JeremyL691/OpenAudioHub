#!/usr/bin/env node
// Verifies a built OpenAudioHub.app (PLAN T14.2): signature, Apple Silicon slices, no external library paths,
// no secret files, the seal intact after the bundled tools run, and a size report. Usage:
//   node desktop/scripts/verify-bundle.mjs <path/to/OpenAudioHub.app> [--report <file.json>]
// Exits 1 when any check fails. Nothing is written into the bundle.
import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const [, , appArg, ...rest] = process.argv;
if (!appArg) {
    console.error(
        "usage: verify-bundle.mjs <OpenAudioHub.app> [--report <file.json>]",
    );
    process.exit(2);
}
const app = resolve(appArg);
const reportIndex = rest.indexOf("--report");
const reportFile = reportIndex >= 0 ? rest[reportIndex + 1] : null;

const results = [];
function check(name, ok, detail = "") {
    results.push({ name, ok, detail });
    console.log(
        `${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`,
    );
}

function walk(dir, out = []) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path, out);
        else if (entry.isFile()) out.push(path);
    }
    return out;
}

function sh(command, args) {
    return spawnSync(command, args, { encoding: "utf8" });
}

// Mach-O files are identified by `file`, which reports one line per architecture for universal files.
const files = walk(app);
const machO = [
    ...new Set(
        files.filter((path) => {
            const out = sh("file", ["-b", path]).stdout;
            return out.includes("Mach-O");
        }),
    ),
];

// 1. Signature: the whole bundle verifies, deep and strict.
const verify = sh("codesign", ["--verify", "--deep", "--strict", app]);
check(
    "codesign verify deep strict",
    verify.status === 0,
    verify.status === 0 ? "" : verify.stderr.trim().split("\n")[0],
);

// 2. Apple Silicon: every Mach-O file has an arm64 slice, and the main executable is thin arm64.
const withoutArm64 = machO.filter((path) => {
    const info = sh("lipo", ["-archs", path]).stdout.trim();
    return !info.split(/\s+/).includes("arm64");
});
check(
    "every Mach-O has an arm64 slice",
    withoutArm64.length === 0,
    withoutArm64.length === 0
        ? `${machO.length} Mach-O files`
        : relative(app, withoutArm64[0]),
);
const mainExecutable = join(app, "Contents", "MacOS");
const mainFiles = readdirSync(mainExecutable);
const mainArchs = sh("lipo", [
    "-archs",
    join(mainExecutable, mainFiles[0]),
]).stdout.trim();
check("main executable is arm64 only", mainArchs === "arm64", mainArchs);

// 3. No external library paths: every linked library is a system path or relative to the bundle. One
// exception is known and recorded (D-350): the protobuf wheel's upb module names a Bazel build path that
// dyld does not need to resolve (the module loads and selects the upb backend).
const knownBuildPathDependencies = [/^bazel-out\//];
const external = [];
const allowed = [];
for (const path of machO) {
    const deps = sh("otool", ["-L", path]).stdout.split("\n").slice(1);
    for (const line of deps) {
        // Dependency lines are tab-indented; the per-architecture headers of universal files are not.
        const match = /^\t(\S+)\s+\(/.exec(line);
        if (!match) continue;
        const dependency = match[1];
        const system =
            dependency.startsWith("/usr/lib/") ||
            dependency.startsWith("/System/");
        const relativeToBundle =
            dependency.startsWith("@rpath/") ||
            dependency.startsWith("@loader_path/") ||
            dependency.startsWith("@executable_path/");
        if (system || relativeToBundle) continue;
        const label = `${relative(app, path)} -> ${dependency}`;
        if (
            knownBuildPathDependencies.some((pattern) =>
                pattern.test(dependency),
            )
        ) {
            allowed.push(label);
        } else {
            external.push(label);
        }
    }
}
check(
    "no external library paths",
    external.length === 0,
    external.length === 0
        ? allowed.length > 0
            ? `${allowed.length} known exception (D-350): ${allowed[0]}`
            : ""
        : external[0],
);

// 4. No secrets: no environment or secrets files, no private keys, and no literal secret assignments.
// Public CA bundles (certifi's cacert.pem) are not secrets, so the check looks for private-key blocks.
const secretFileNames =
    /(^|\/)(\.env(\..*)?|secrets\.json|openaudiohub\.env|id_rsa|.*\.p12)$/;
const secretFiles = files
    .map((path) => relative(app, path))
    .filter((path) => secretFileNames.test(path));
check(
    "no secret files in the bundle",
    secretFiles.length === 0,
    secretFiles.length === 0 ? "" : secretFiles[0],
);
const assignment =
    /(BETTER_AUTH_SECRET|ENCRYPTION_KEY|POSTGRES_PASSWORD|API_TOKEN_HASH_SECRET|AUDIO_PIPELINE_TOKEN)=[^\s'"]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const literal = [];
for (const path of files) {
    const size = statSync(path).size;
    if (size > 5 * 1024 * 1024) continue;
    const text = readFileSync(path, "latin1");
    if (assignment.test(text)) {
        literal.push(relative(app, path));
        if (literal.length >= 3) break;
    }
}
check(
    "no literal secret assignments",
    literal.length === 0,
    literal.length === 0 ? "" : literal.join(", "),
);

// 5. The seal is intact after the bundled tools run (they run from the bundle, not from a copy).
const tools = [
    ["Contents/Resources/postgres/bin/postgres", ["--version"]],
    ["Contents/Resources/postgres/bin/pg_dump", ["--version"]],
    ["Contents/Resources/bin/ffmpeg", ["-version"]],
];
for (const [tool, args] of tools) {
    const path = join(app, tool);
    const run = sh(path, args);
    check(
        `bundled tool runs: ${tool}`,
        run.status === 0,
        run.status === 0 ? run.stdout.split("\n")[0] : `exit ${run.status}`,
    );
}
const afterRun = sh("codesign", ["--verify", "--deep", "--strict", app]);
check("seal intact after the tools ran", afterRun.status === 0);

// 6. Size report.
const sizeOf = (dir) =>
    Number(
        execFileSync("du", ["-sk", join(app, dir)])
            .toString()
            .split("\t")[0],
    ) * 1024;
const sizes = {
    total:
        Number(execFileSync("du", ["-sk", app]).toString().split("\t")[0]) *
        1024,
    postgres: sizeOf("Contents/Resources/postgres"),
    python: sizeOf("Contents/Resources/python"),
    server: sizeOf("Contents/Resources/server"),
    ffmpeg: sizeOf("Contents/Resources/bin"),
    pipeline: sizeOf("Contents/Resources/audio-pipeline"),
};
console.log(`size: ${JSON.stringify(sizes)}`);

const failed = results.filter((result) => !result.ok);
const summary = { app, checks: results, sizes, passed: failed.length === 0 };
if (reportFile)
    writeFileSync(reportFile, `${JSON.stringify(summary, null, 2)}\n`);
console.log(
    `${results.length - failed.length}/${results.length} checks passed`,
);
process.exitCode = failed.length === 0 ? 0 : 1;
