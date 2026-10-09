#!/usr/bin/env node
// Restart hook for desktop-long-smoke.mjs (PLAN T16.4). The flow runs it where it would run `docker restart`. It
// asks the driver to restart the app, which the driver does through Electron, and returns once the restarted app
// answers. It only means something inside a driver run: the driver is the one that watches the request file.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) {
    console.error("usage: long-smoke-restart-hook.mjs <smoke directory>");
    process.exit(2);
}
writeFileSync(join(dir, "restart-request"), new Date().toISOString());
const deadline = Date.now() + 600_000;
while (!existsSync(join(dir, "restart-done"))) {
    if (Date.now() > deadline) {
        console.error("restart timed out");
        process.exit(1);
    }
    await new Promise((done) => setTimeout(done, 1000));
}
const outcome = readFileSync(join(dir, "restart-done"), "utf8");
rmSync(join(dir, "restart-done"), { force: true });
if (outcome !== "ok") {
    console.error("the app did not restart");
    process.exit(1);
}
