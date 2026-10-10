#!/usr/bin/env node
// T13.4–T13.5 smoke (PLAN T13.4, T13.5): launches the built main process with Electron through Playwright's
// _electron, and checks three things in order.
//   A. The window reaches /dashboard with a session cookie in the persist:oah partition and the app shell.
//   B. Closing the window keeps the app running in the menu bar; activating the app opens the window again.
//   C. A force-killed main process is followed by a fresh launch on the same data directory that reaches
//      /dashboard again (D-347(e): the stale PostgreSQL postmaster must not block the restart).
// Then it quits and checks that the test ports are free. Runs against desktop/build (run build-main.mjs
// first). It uses its own data directory and test ports (>= 38500), never the real app data directory.
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
const mainDir = join(desktopRoot, "build", "main");

const runId = new Date().toISOString().replace(/[:.]/g, "-");
const userData = join(
    repoRoot,
    ".dev-artifacts",
    "desktop-userdata",
    `t13-smoke-${runId}`,
);
const ports = { app: 38510, pipeline: 38511, postgres: 38512 };
const resultFile = join(
    repoRoot,
    ".dev-artifacts",
    "logs",
    `T13-smoke-${runId}.json`,
);
const LAUNCH_TIMEOUT = 240_000;

mkdirSync(userData, { recursive: true, mode: 0o700 });
writeFileSync(
    join(userData, "config.json"),
    JSON.stringify({ schemaVersion: 1, ports }),
    { mode: 0o600 },
);

const results = {};

function listening(port) {
    const out = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]);
    return out.stdout.toString().trim().split("\n").length > 1;
}

function anyListening() {
    return [ports.app, ports.pipeline, ports.postgres].some(listening);
}

function listenersText() {
    return [ports.app, ports.pipeline, ports.postgres]
        .map((port) => spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]).stdout.toString().trim())
        .filter(Boolean)
        .join("\n");
}

async function waitForPortsFree(ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && anyListening()) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }
    return !anyListening();
}

// OAH_SMOKE_APP=<path to OpenAudioHub.app> runs the same checks against a packaged build (T14.1, T16.3).
const packagedApp = process.env.OAH_SMOKE_APP
    ? resolve(process.env.OAH_SMOKE_APP)
    : null;
const packagedExecutable = packagedApp
    ? join(packagedApp, "Contents", "MacOS", "OpenAudioHub")
    : null;
// The processes this run starts (postgres, the pipeline, the server) run from the bundle it launched: the packaged
// Resources folder, or desktop/build in dev. Cleanup and the leftover count match only that path (escaped), never
// every postgres/python/server on the host: another run may be using its own app at the same time.
const launchedRoot = packagedApp
    ? join(packagedApp, "Contents", "Resources")
    : join(desktopRoot, "build");
const ownProcessPattern = `${launchedRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(postgres|python|server)`;

function launchEnv() {
    return {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME ?? "",
        TZ: "UTC",
        OAH_USER_DATA_DIR: userData,
        ...(packagedApp ? { OAH_SKIP_MOVE_TO_APPLICATIONS: "1" } : {}),
    };
}

function phase(name) {
    console.log(`[smoke] ${new Date().toISOString()} ${name}`);
}

function isRunning(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function launch() {
    return electron.launch({
        executablePath: packagedExecutable ?? electronBinary,
        args: packagedExecutable ? [] : [mainDir],
        env: launchEnv(),
        timeout: LAUNCH_TIMEOUT,
    });
}

/** The page reached /dashboard. Returns the path it reached. */
async function reachDashboard(page) {
    await page.waitForURL(/\/dashboard(\?|$|\/)/, { timeout: LAUNCH_TIMEOUT });
    return new URL(page.url()).pathname;
}

phase("A: first launch");
// --- A. first launch -------------------------------------------------------------------------------
let app = await launch();
// Playwright's handle can become unusable once the last window closes, so keep the main pid now.
const mainPid = app.process().pid;
try {
    const page = await app.firstWindow({ timeout: LAUNCH_TIMEOUT });
    results.url = await reachDashboard(page);
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
    results.appShellVisible = await page
        .getByTestId("nav-recordings")
        .first()
        .waitFor({ state: "visible", timeout: 30_000 })
        .then(() => true)
        .catch(() => false);

    phase("B: window lifecycle");

    // --- B. window lifecycle (D-305) ---------------------------------------------------------------
    // Playwright quits the app when its last window closes, which is not the app's behavior. So a hidden
    // holder window stays open while the dashboard window is closed. The zero-window case is a manual
    // check (B-007).
    await app.evaluate(async ({ BrowserWindow }) => {
        const holder = new BrowserWindow({ show: false });
        await holder.loadURL("about:blank");
    });
    await app.evaluate(({ BrowserWindow }) => {
        for (const win of BrowserWindow.getAllWindows()) {
            if (win.webContents.getURL().includes("/dashboard")) win.close();
        }
    });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_500));
    results.windowsAfterClose = await app
        .evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
        .catch(() => -1);
    results.appRunningWithDashboardClosed = isRunning(mainPid);
    // A second launch while the app runs is the single-instance path: it brings the window back.
    const reopened = app.waitForEvent("window", { timeout: LAUNCH_TIMEOUT });
    const second = spawnSync(packagedExecutable ?? electronBinary, packagedExecutable ? [] : [mainDir], {
        env: launchEnv(),
        timeout: 30_000,
    });
    results.secondLaunchExitCode = second.status;
    const page2 = await reopened;
    results.reopenedUrl = await reachDashboard(page2);
    results.reopenedDashboard = results.reopenedUrl.startsWith("/dashboard");
} finally {
    await app.close();
}
results.portsFreeAfterFirstQuit = await waitForPortsFree(15_000);
if (!results.portsFreeAfterFirstQuit) results.listenersAfterFirstQuit = listenersText();

phase("C: force-kill and restart");
// --- C. force-killed main process, then a fresh launch on the same data ----------------------------
app = await launch();
const killed = app.process().pid;
try {
    const page = await app.firstWindow({ timeout: LAUNCH_TIMEOUT });
    await reachDashboard(page);
    results.beforeKillReached = true;
} finally {
    process.kill(killed, "SIGKILL");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
}
results.killedMainPid = killed;
results.leftoverAfterKill = spawnSync("pgrep", ["-f", ownProcessPattern])
    .stdout.toString()
    .trim()
    .split("\n")
    .filter(Boolean).length;

// Pretend the data was written by an older version, so the restart takes the pre-upgrade backup (T13.6).
const configPath = join(userData, "config.json");
const savedConfig = JSON.parse(readFileSync(configPath, "utf8"));
writeFileSync(
    configPath,
    JSON.stringify({ ...savedConfig, lastVersion: "0.0.1" }),
    { mode: 0o600 },
);

app = await launch();
try {
    const page = await app.firstWindow({ timeout: LAUNCH_TIMEOUT });
    results.restartedUrl = await reachDashboard(page);
    results.restartedDashboard = results.restartedUrl.startsWith("/dashboard");
} finally {
    await app.close();
}
results.portsFreeAfterSecondQuit = await waitForPortsFree(15_000);
if (!results.portsFreeAfterSecondQuit) results.listenersAfterSecondQuit = listenersText();
results.upgradeBackups = readdirSync(join(userData, "backups")).filter((name) =>
    name.endsWith(".dump"),
).length;

// Clean up anything the forced kill left behind: only processes started from the bundle this run launched.
spawnSync("pkill", ["-9", "-f", ownProcessPattern]);
results.portsFreeAtEnd = !anyListening();
results.userData = userData;

writeFileSync(resultFile, `${JSON.stringify(results, null, 2)}\n`);
console.log(JSON.stringify(results, null, 2));

const pass =
    results.reachedDashboard &&
    results.sessionCookie &&
    results.appShellVisible &&
    results.windowsAfterClose === 1 &&
    results.appRunningWithDashboardClosed &&
    results.secondLaunchExitCode === 0 &&
    results.reopenedDashboard &&
    results.restartedDashboard &&
    results.upgradeBackups >= 1 &&
    results.portsFreeAfterSecondQuit;
process.exitCode = pass ? 0 : 1;
