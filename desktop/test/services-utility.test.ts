import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import type { UtilityProcess } from "electron";
import { describe, expect, it } from "vitest";
import { fromUtilityProcess } from "../src/main/services.js";

describe("utility process handle", () => {
    it("sends SIGKILL to the OS when the process traps SIGTERM", async () => {
        const child = spawn(
            process.execPath,
            [
                "-e",
                'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);',
            ],
            { stdio: "ignore" },
        );
        // Electron's UtilityProcess.kill() takes no signal and sends the default one, which this child traps.
        const utility = Object.assign(new EventEmitter(), {
            pid: child.pid,
            kill: () => true,
        });
        child.on("exit", (code) => utility.emit("exit", code));
        try {
            const handle = fromUtilityProcess(
                utility as unknown as UtilityProcess,
            );
            const exited = new Promise<number | null>((resolve) => {
                handle.onExit(resolve);
            });

            expect(handle.kill("SIGKILL")).toBe(true);

            await expect(exited).resolves.toBeNull();
        } finally {
            child.kill("SIGKILL");
        }
    }, 20_000);
});
