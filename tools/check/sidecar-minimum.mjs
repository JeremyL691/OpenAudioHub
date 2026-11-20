import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function checkMinimum(output, minimum) {
    const versions = [...output.matchAll(/^\s*minos\s+(\d+(?:\.\d+)+)\s*$/gm)].map((match) => match[1]);
    assert(versions.length > 0, "no macOS minimum version found");
    const parts = (version) => version.split(".").map(Number);
    const allowed = parts(minimum);
    for (const version of versions) {
        const actual = parts(version);
        let comparison = 0;
        for (let i = 0; i < Math.max(actual.length, allowed.length); i++) {
            comparison = (actual[i] || 0) - (allowed[i] || 0);
            if (comparison !== 0) break;
        }
        assert(comparison <= 0, `sidecar minimum macOS ${version} exceeds app minimum ${minimum}`);
    }
    return versions;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const config = JSON.parse(readFileSync(new URL("../../desktop-tauri/tauri.conf.json", import.meta.url), "utf8"));
    const minimum = config.bundle.macOS.minimumSystemVersion;
    assert(process.argv.length > 2, "provide the sidecar binaries to check");
    for (const binary of process.argv.slice(2)) {
        const output = execFileSync("xcrun", ["vtool", "-show-build", binary], { encoding: "utf8" });
        const versions = checkMinimum(output, minimum);
        console.log(`${binary}: minimum macOS ${versions.join(", ")} <= ${minimum}`);
    }
}
