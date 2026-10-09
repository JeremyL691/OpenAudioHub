import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bundleOf, removeQuarantine } from "../src/main/quarantine.js";

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oah-quarantine-"));
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

function hasQuarantine(path: string): boolean {
    try {
        execFileSync("xattr", ["-p", "com.apple.quarantine", path], {
            stdio: "ignore",
        });
        return true;
    } catch {
        return false;
    }
}

describe("bundleOf", () => {
    it("finds the .app bundle that contains the executable", () => {
        expect(
            bundleOf(
                "/Applications/OpenAudioHub.app/Contents/MacOS/OpenAudioHub",
            ),
        ).toBe("/Applications/OpenAudioHub.app");
    });

    it("returns null outside a bundle", () => {
        expect(bundleOf("/usr/local/bin/electron")).toBeNull();
        expect(
            bundleOf("/tmp/x/Electron.app/Contents/MacOS/Electron/extra"),
        ).toBeNull();
    });
});

describe("removeQuarantine", () => {
    it("removes the attribute from the bundle and its contents", () => {
        const bundle = join(dir, "OpenAudioHub.app");
        const macos = join(bundle, "Contents", "MacOS");
        mkdirSync(macos, { recursive: true });
        const binary = join(macos, "OpenAudioHub");
        writeFileSync(binary, "x");
        execFileSync("xattr", [
            "-w",
            "com.apple.quarantine",
            "0081;0;Safari;",
            bundle,
        ]);
        execFileSync("xattr", [
            "-w",
            "com.apple.quarantine",
            "0081;0;Safari;",
            binary,
        ]);
        expect(hasQuarantine(bundle)).toBe(true);

        expect(removeQuarantine(bundle)).toBe(true);

        expect(hasQuarantine(bundle)).toBe(false);
        expect(hasQuarantine(binary)).toBe(false);
    });

    it("does nothing when the bundle is not quarantined", () => {
        const bundle = join(dir, "Clean.app");
        mkdirSync(bundle);

        expect(removeQuarantine(bundle)).toBe(false);
    });
});
