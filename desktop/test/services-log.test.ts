import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fromChildProcess } from "../src/main/services.js";

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oah-services-log-"));
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

/** Runs a short Node script with its output captured, and resolves with its exit code. */
function runScript(script: string, logFile: string): Promise<number | null> {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, ["-e", script], {
            stdio: ["ignore", "pipe", "pipe"],
        });
        fromChildProcess(child, logFile).onExit(resolve);
    });
}

describe("service output", () => {
    it("appends stdout and stderr to the log file", async () => {
        const logFile = join(dir, "service.log");

        const code = await runScript(
            'console.log("out line"); console.error("err line");',
            logFile,
        );

        expect(code).toBe(0);
        const text = readFileSync(logFile, "utf8");
        expect(text).toContain("out line");
        expect(text).toContain("err line");
    }, 20_000);

    it("does not block a child that writes more than a pipe buffer", async () => {
        const logFile = join(dir, "large.log");
        const size = 1024 * 1024;

        const code = await runScript(
            `process.stdout.write("x".repeat(${size}));`,
            logFile,
        );

        expect(code).toBe(0);
        expect(statSync(logFile).size).toBe(size);
    }, 20_000);
});
