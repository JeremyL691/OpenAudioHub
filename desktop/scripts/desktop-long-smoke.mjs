#!/usr/bin/env node
// Long-audio flow against the packaged Mac app (PLAN T16.4). It runs the same stages as the Docker smoke
// (scripts/dev/docker-smoke-flow.py): a 12-minute recording, the upload and transcription, a restart part-way
// through, and the checks. Here the restart quits the app through Electron (before-quit stops the services),
// starts it again on the same data, and waits until its window is back.
//
//   OAH_SMOKE_APP=<test build OpenAudioHub.app> node desktop/scripts/desktop-long-smoke.mjs
//
// The app is a test build (dist --test-fuses) so Playwright can attach. The fake AI server runs on 127.0.0.1:3299
// (the E2E port), so no other run may use it. Session values are passed on to the flow as environment variables
// and are never printed. Results go to .dev-artifacts/smoke-desktop-<run>/ and a summary to .dev-artifacts/logs/.
import { spawn, spawnSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "..");
const appBundle = process.env.OAH_SMOKE_APP
    ? resolve(process.env.OAH_SMOKE_APP)
    : null;
if (!appBundle) {
    console.error(
        "set OAH_SMOKE_APP to the test build's OpenAudioHub.app (dist --test-fuses)",
    );
    process.exit(2);
}
const executable = join(appBundle, "Contents", "MacOS", "OpenAudioHub");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const dataDir = join(
    repoRoot,
    ".dev-artifacts",
    "desktop-userdata",
    `long-smoke-${runId}`,
);
const smokeDir = join(repoRoot, ".dev-artifacts", `smoke-desktop-${runId}`);
const logsDir = join(
    repoRoot,
    ".dev-artifacts",
    "logs",
    `desktop-long-smoke-${runId}`,
);
const requestFile = join(smokeDir, "restart-request");
const doneFile = join(smokeDir, "restart-done");
const ports = { app: 38900, pipeline: 38901, postgres: 38902 };
const providerPort = 3299;
const LAUNCH_TIMEOUT = 240_000;

const phase = (name) =>
    console.log(`[long-smoke] ${new Date().toISOString()} ${name}`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function listening(port) {
    const out = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], {
        encoding: "utf8",
    });
    return out.stdout.trim().split("\n").length > 1;
}

async function waitForPortsFree(ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (![ports.app, ports.pipeline, ports.postgres].some(listening))
            return true;
        await sleep(500);
    }
    return false;
}

async function waitForHttp(url, ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(url);
            if (response.status < 500) return true;
        } catch {
            // not up yet
        }
        await sleep(1000);
    }
    return false;
}

mkdirSync(dataDir, { recursive: true, mode: 0o700 });
mkdirSync(smokeDir, { recursive: true, mode: 0o700 });
mkdirSync(logsDir, { recursive: true, mode: 0o700 });
writeFileSync(
    join(dataDir, "config.json"),
    JSON.stringify({ schemaVersion: 1, ports }),
    { mode: 0o600 },
);

if ([providerPort, ports.app].some(listening)) {
    console.error(
        `port ${providerPort} or ${ports.app} is busy; stop the other run first`,
    );
    process.exit(1);
}

const appEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "",
    TZ: "UTC",
    OAH_USER_DATA_DIR: dataDir,
    OAH_SKIP_MOVE_TO_APPLICATIONS: "1",
};

function launch() {
    return electron.launch({
        executablePath: executable,
        args: [],
        env: appEnv,
        timeout: LAUNCH_TIMEOUT,
    });
}

/** Reaches /dashboard, marks onboarding done (as the Docker smoke does), and returns the page. */
async function dashboard(app) {
    const page = await app.firstWindow({ timeout: LAUNCH_TIMEOUT });
    await page.waitForURL(/\/dashboard(\?|$|\/)/, { timeout: LAUNCH_TIMEOUT });
    await page.evaluate(async () => {
        await fetch("/api/settings/user", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ onboardingCompleted: true }),
        });
    });
    await page.reload();
    await page.waitForURL(/\/dashboard(\?|$|\/)/, { timeout: LAUNCH_TIMEOUT });
    return page;
}

let fakeProvider = null;
let app = null;
let restarting = false;
let restarts = 0;

async function cookieHeader() {
    const cookies = await app.evaluate(async ({ session }) =>
        (await session.fromPartition("persist:oah").cookies.get({})).map(
            (cookie) => ({
                name: cookie.name,
                value: cookie.value,
            }),
        ),
    );
    const session = cookies.find((cookie) =>
        cookie.name.includes("session_token"),
    );
    if (!session) throw new Error("the app has no session cookie");
    return `${session.name}=${session.value}`;
}

/** The restart the flow asks for: the app quits through Electron, starts again on the same data, and answers. */
async function performRestart() {
    rmSync(requestFile, { force: true });
    phase("restart requested by the flow: quitting the app through Electron");
    try {
        await app.evaluate(({ app: electronApp }) => electronApp.quit());
    } catch {
        // The handle may already be gone once the app quits.
    }
    if (!(await waitForPortsFree(120_000)))
        throw new Error("ports did not free after the quit");
    app = await launch();
    await dashboard(app);
    if (
        !(await waitForHttp(
            `http://127.0.0.1:${ports.app}/api/health`,
            180_000,
        ))
    ) {
        throw new Error("the restarted app did not answer /api/health");
    }
    restarts += 1;
    phase(`app restarted (${restarts})`);
    writeFileSync(doneFile, "ok");
}

phase(
    "starting the fake AI server (3000 ms per transcription, as the Docker smoke runs it)",
);
// Without the latency the job finishes in about six seconds, before the flow's restart window (progress 0.2 to 0.95)
// can be observed. The Docker smoke uses FAKE_AI_LATENCY_MS=3000 for the same reason (TEST_RESULTS, T7.4).
fakeProvider = spawn("bun", ["scripts/dev/fake-ai-server.ts"], {
    cwd: repoRoot,
    env: {
        ...process.env,
        FAKE_AI_PORT: String(providerPort),
        FAKE_AI_LATENCY_MS: "3000",
    },
    stdio: "ignore",
});
if (
    !(await waitForHttp(`http://127.0.0.1:${providerPort}/v1/models`, 30_000))
) {
    fakeProvider.kill("SIGTERM");
    throw new Error("the fake AI server did not start");
}

phase("launching the packaged app");
app = await launch();
await dashboard(app);
const cookie = await cookieHeader();
phase("signed in through the app's own session (value not printed)");

const flowEnv = {
    ...process.env,
    OAH_SMOKE_DIR: smokeDir,
    OAH_SMOKE_LOGS: logsDir,
    OAH_SMOKE_BASE_URL: `http://127.0.0.1:${ports.app}`,
    OAH_SMOKE_PROVIDER_URL: `http://127.0.0.1:${providerPort}/v1`,
    OAH_SMOKE_SESSION_COOKIE: cookie,
    OAH_SMOKE_RESTART_CMD: `node ${join(here, "long-smoke-restart-hook.mjs")} ${smokeDir}`,
    OAH_SMOKE_PIPELINE_LOG: join(dataDir, "logs", "pipeline.log"),
};

const watcher = setInterval(() => {
    if (existsSync(requestFile) && !restarting) {
        restarting = true;
        performRestart()
            .catch((error) => {
                console.error(`[long-smoke] restart failed: ${error.message}`);
                writeFileSync(doneFile, "failed");
            })
            .finally(() => {
                restarting = false;
            });
    }
}, 1000);

phase("running the flow (scripts/dev/docker-smoke-flow.py all)");
const flowExit = await new Promise((done) => {
    const child = spawn(
        "python3",
        ["-I", join(repoRoot, "scripts/dev/docker-smoke-flow.py"), "all"],
        {
            cwd: repoRoot,
            env: flowEnv,
            stdio: "inherit",
        },
    );
    child.on("exit", (code) => done(code));
});
clearInterval(watcher);

phase(`flow finished with exit ${flowExit}`);
try {
    await app.evaluate(({ app: electronApp }) => electronApp.quit());
} catch {
    // already gone
}
await waitForPortsFree(120_000);
fakeProvider.kill("SIGTERM");

const verifyFile = join(smokeDir, "verify.json");
const verify = existsSync(verifyFile)
    ? JSON.parse(readFileSync(verifyFile, "utf8"))
    : {};
const checks = verify.checks ?? {};
const summary = {
    runId,
    flowExit,
    restarts,
    checksPassed: Object.values(checks).filter(Boolean).length,
    checksTotal: Object.keys(checks).length,
    failed: Object.entries(checks)
        .filter(([, ok]) => !ok)
        .map(([name]) => name),
    portsFreeAtEnd:
        !listening(ports.app) &&
        !listening(ports.pipeline) &&
        !listening(ports.postgres),
};
writeFileSync(
    join(logsDir, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
);
writeFileSync(
    join(
        repoRoot,
        ".dev-artifacts",
        "logs",
        `desktop-long-smoke-${runId}.json`,
    ),
    `${JSON.stringify(summary, null, 2)}\n`,
);
console.log(JSON.stringify(summary, null, 2));
process.exit(
    flowExit === 0 && summary.checksTotal > 0 && summary.failed.length === 0
        ? 0
        : 1,
);
