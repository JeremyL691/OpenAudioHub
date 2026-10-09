#!/usr/bin/env node
// T13.4 smoke (PLAN T13.4): launches the built main process with Electron, waits for the window to reach
// /dashboard, checks that a session cookie exists, quits, and confirms that the ports are free again.
// Runs against desktop/build (npm run build:main first). It uses its own data directory and test ports
// (>= 38500), never the real app data directory.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..", "..");
const repoRoot = resolve(desktopRoot, "..");
const electronBinary = createRequire(join(desktopRoot, "package.json"))(
    "electron",
);
const mainJs = join(desktopRoot, "build", "main", "main.cjs");

const runId = new Date().toISOString().replace(/[:.]/g, "-");
const userData = join(
    repoRoot,
    ".dev-artifacts",
    "desktop-userdata",
    `t13-4-smoke-${runId}`,
);
const ports = { app: 38510, pipeline: 38511, postgres: 38512 };
const resultFile = join(
    repoRoot,
    ".dev-artifacts",
    "logs",
    `T13.4-smoke-${runId}.json`,
);

mkdirSync(userData, { recursive: true, mode: 0o700 });
writeFileSync(
    join(userData, "config.json"),
    JSON.stringify({ schemaVersion: 1, ports }),
    { mode: 0o600 },
);

const results = {};
const LAUNCH_TIMEOUT = 240_000;

function listening(port) {
    const out = spawnSync("lsof", [
        "-nP",
        `-iTCP:${port}`,
        "-sTCP:LISTEN",
    ]);
    return out.stdout.toString().trim().split("\n").length > 1;
}

const app = await electron.launch({
    executablePath: electronBinary,
    args: [mainJs],
    env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME ?? "",
        TZ: "UTC",
        OAH_USER_DATA_DIR: userData,
    },
    timeout: LAUNCH_TIMEOUT,
});

try {
    const page = await app.firstWindow({ timeout: LAUNCH_TIMEOUT });
    await page.waitForURL(/\/dashboard(\?|$|\/)/, { timeout: LAUNCH_TIMEOUT });
    results.url = new URL(page.url()).pathname;
    results.reachedDashboard = results.url.startsWith("/dashboard");

    // The window uses the persist:oah partition, which is not Playwright's default context. Read the
    // cookie names from that partition in the main process (names only, never values).
    const cookieNames = await app.evaluate(async ({ session }) => {
        const cookies = await session.fromPartition("persist:oah").cookies.get({});
        return cookies.map((cookie) => cookie.name);
    });
    results.cookieNames = cookieNames;
    results.sessionCookie = cookieNames.some((name) =>
        name.includes("session_token"),
    );
    // The app shell of the signed-in pages: the navigation link to the recordings library.
    results.appShellVisible = await page
        .getByTestId("nav-recordings")
        .first()
        .waitFor({ state: "visible", timeout: 30_000 })
        .then(() => true)
        .catch(() => false);
    results.title = await page.title();
    results.appPackaged = await app.evaluate(({ app }) => app.isPackaged);
} finally {
    await app.close();
}

// After quit, the supervisor stops the services in reverse order. Give the stop budget time to finish.
const deadline = Date.now() + 15_000;
while (
    Date.now() < deadline &&
    (listening(ports.app) ||
        listening(ports.pipeline) ||
        listening(ports.postgres))
) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
}
results.portsFreeAfterQuit = ![ports.app, ports.pipeline, ports.postgres].some(
    listening,
);
results.userData = userData;

writeFileSync(resultFile, `${JSON.stringify(results, null, 2)}\n`);
console.log(JSON.stringify(results, null, 2));

const pass =
    results.reachedDashboard &&
    results.sessionCookie &&
    results.appShellVisible &&
    results.portsFreeAfterQuit;
process.exitCode = pass ? 0 : 1;
