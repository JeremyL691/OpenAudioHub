/**
 * `_electron` suite for the packaged macOS app (PLAN T16.3). It runs against a test build (`dist --test-fuses`,
 * so Playwright can attach) and needs OAH_SMOKE_APP set to that build's OpenAudioHub.app. Each test has its own
 * data directory under .dev-artifacts and ports from 38540 up, so the real app data is never touched. The
 * window lifecycle and the force-kill restart are in test/smoke/dashboard.smoke.mjs, run separately.
 */
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    type ElectronApplication,
    _electron as electron,
    expect,
    type Page,
    test,
} from "@playwright/test";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const appBundle = process.env.OAH_SMOKE_APP
    ? resolve(process.env.OAH_SMOKE_APP)
    : null;
const executable = appBundle
    ? join(appBundle, "Contents", "MacOS", "OpenAudioHub")
    : "";
/** The rehearsal export from scripts/export-for-desktop.sh (PLAN T15.1). Git-ignored, so the import case skips without it. */
const exportDir = join(repoRoot, ".dev-artifacts", "rehearsal", "export-2");
const hasExport = existsSync(join(exportDir, "manifest.json"));
/** The rehearsal stack's test account (a seed fixture, not a real person). */
const rehearsalAccount = "rehearsal@openaudiohub.localhost";
const LAUNCH_TIMEOUT = 240_000;
const runId = new Date().toISOString().replace(/[:.]/g, "-");

test.skip(
    !appBundle,
    "set OAH_SMOKE_APP to the test build's OpenAudioHub.app (dist --test-fuses)",
);
test.describe.configure({ mode: "serial", timeout: 900_000 });

let nextPort = 38540;

function makeDataDir(name: string): string {
    const dir = join(
        repoRoot,
        ".dev-artifacts",
        "desktop-userdata",
        `e2e-${name}-${runId}`,
    );
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
}

/** Writes config.json with three fresh ports (the App keeps saved ports that are free). */
function usePorts(dataDir: string): { app: number; pipeline: number; postgres: number } {
    const ports = {
        app: nextPort,
        pipeline: nextPort + 1,
        postgres: nextPort + 2,
    };
    nextPort += 10;
    writeFileSync(
        join(dataDir, "config.json"),
        JSON.stringify({ schemaVersion: 1, ports }),
        { mode: 0o600 },
    );
    return ports;
}

function appEnv(dataDir: string): Record<string, string> {
    return {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME ?? "",
        TZ: "UTC",
        OAH_USER_DATA_DIR: dataDir,
        OAH_SKIP_MOVE_TO_APPLICATIONS: "1",
    };
}

function launch(dataDir: string): Promise<ElectronApplication> {
    return electron.launch({
        executablePath: executable,
        args: [],
        env: appEnv(dataDir),
        timeout: LAUNCH_TIMEOUT,
    });
}

/**
 * The first window has reached /dashboard (the App signs itself in, so this is the first page). A new local
 * account opens with the onboarding dialog, which blocks the page; the suite marks it done, as the Docker smoke
 * does, and reloads.
 */
async function dashboard(app: ElectronApplication): Promise<Page> {
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

/** Runs the packaged binary with command-line arguments (exit codes are cli.ts's). */
function cli(dataDir: string, args: string[]): { status: number | null; stderr: string } {
    const run = spawnSync(executable, args, {
        env: appEnv(dataDir),
        encoding: "utf8",
        timeout: LAUNCH_TIMEOUT,
    });
    return { status: run.status, stderr: run.stderr };
}

async function openRecordings(page: Page): Promise<void> {
    await page.goto(new URL("/recordings", page.url()).toString());
    await page.waitForLoadState("networkidle");
}

test("first launch signs itself in and shows the dashboard", async () => {
    const dataDir = makeDataDir("first-launch");
    usePorts(dataDir);
    const app = await launch(dataDir);
    try {
        const page = await dashboard(app);
        await expect(page.getByTestId("nav-recordings").first()).toBeVisible({
            timeout: 30_000,
        });
    } finally {
        await app.close();
    }
});

test("the desktop app has no log-out entry", async () => {
    const dataDir = makeDataDir("no-logout");
    usePorts(dataDir);
    const app = await launch(dataDir);
    try {
        const page = await dashboard(app);
        await page.getByTestId("user-menu").click();
        await expect(page.getByText("Local account")).toBeVisible();
        await expect(page.getByText("Log out", { exact: true })).toHaveCount(0);
    } finally {
        await app.close();
    }
});

test("/login sends the desktop app to the dashboard", async () => {
    const dataDir = makeDataDir("login-intercept");
    usePorts(dataDir);
    const app = await launch(dataDir);
    try {
        const page = await dashboard(app);
        await page.goto(new URL("/login", page.url()).toString());
        await page.waitForURL(/\/dashboard(\?|$|\/)/, { timeout: 60_000 });
    } finally {
        await app.close();
    }
});

test("a busy saved port moves the app to free ports and says so", async () => {
    const dataDir = makeDataDir("busy-port");
    const ports = usePorts(dataDir);
    // Hold the saved app port, as another program would.
    const blocker = createServer();
    await new Promise<void>((done) =>
        blocker.listen(ports.app, "127.0.0.1", () => done()),
    );
    try {
        const app = await launch(dataDir);
        try {
            const page = await dashboard(app);
            await expect(page.getByTestId("nav-recordings").first()).toBeVisible(
                { timeout: 30_000 },
            );
        } finally {
            await app.close();
        }
    } finally {
        await new Promise<void>((done) => blocker.close(() => done()));
    }
    const saved = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8"));
    expect(saved.ports.app).not.toBe(ports.app);
    expect(readFileSync(join(dataDir, "logs", "main.log"), "utf8")).toContain(
        "a saved port was busy",
    );
});

test("a Docker export imports, shows its recordings, survives a restart, and rolls back", async () => {
    test.skip(
        !hasExport,
        "the rehearsal export is absent (scripts/export-for-desktop.sh)",
    );
    const dataDir = makeDataDir("import");
    usePorts(dataDir);

    const imported = cli(dataDir, [
        "--import",
        exportDir,
        "--user-email",
        rehearsalAccount,
    ]);
    expect(imported.status, imported.stderr).toBe(0);

    let recordingCount = 0;
    let app = await launch(dataDir);
    try {
        const page = await dashboard(app);
        await openRecordings(page);
        const rows = page.getByTestId("recording-row");
        await expect(rows.first()).toBeVisible({ timeout: 60_000 });
        recordingCount = await rows.count();
        expect(recordingCount).toBeGreaterThan(0);

        // The signed-in page reads the imported audio (with range support), exports the transcripts as JSON, and
        // builds the backup ZIP (an export job: create, poll until completed, download).
        const served = await page.evaluate(async () => {
            const row = document.querySelector('[data-testid="recording-row"]');
            const id = row?.getAttribute("data-id") ?? "";
            const audio = await fetch(`/api/recordings/${id}/audio`, {
                headers: { Range: "bytes=0-1023" },
            });
            const json = await fetch("/api/export?format=json");
            const created = await fetch("/api/backup", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: "{}",
            });
            const jobId = ((await created.json()) as { job?: { id?: string } })
                .job?.id;
            let zipStatus = 0;
            let zipType = "";
            let jobStatus = "none";
            for (let attempt = 0; attempt < 150 && jobId; attempt += 1) {
                await new Promise((done) => setTimeout(done, 2_000));
                const job = (await (await fetch(`/api/backup/${jobId}`)).json()) as {
                    job?: { status?: string };
                };
                jobStatus = job.job?.status ?? "unknown";
                if (jobStatus === "completed" || jobStatus === "failed") break;
            }
            if (jobId && jobStatus === "completed") {
                const zip = await fetch(`/api/backup/${jobId}/download`);
                zipStatus = zip.status;
                zipType = zip.headers.get("content-type") ?? "";
            }
            return {
                ids: Array.from(
                    document.querySelectorAll('[data-testid="recording-row"]'),
                    (node) => node.getAttribute("data-id") ?? "",
                ),
                audioStatus: audio.status,
                jsonStatus: json.status,
                jsonType: json.headers.get("content-type") ?? "",
                jobStatus,
                zipStatus,
                zipType,
            };
        });
        expect(served.audioStatus).toBe(206);
        expect(served.jsonStatus).toBe(200);
        expect(served.jsonType).toContain("json");
        expect(served.jobStatus).toBe("completed");
        expect(served.zipStatus).toBe(200);
        expect(served.zipType).toContain("zip");

        // The in-browser transcription button renders on a recording that has no transcript yet.
        let buttonRendered = false;
        for (const id of served.ids) {
            await page.goto(
                new URL(`/recordings?id=${id}`, page.url()).toString(),
            );
            await page.waitForLoadState("networkidle");
            buttonRendered = await page
                .getByRole("button", { name: "Transcribe in browser" })
                .first()
                .isVisible()
                .catch(() => false);
            if (buttonRendered) break;
        }
        expect(buttonRendered).toBe(true);
    } finally {
        await app.close();
    }

    // A restart on the same data shows the same recordings.
    app = await launch(dataDir);
    try {
        const page = await dashboard(app);
        await openRecordings(page);
        await expect(page.getByTestId("recording-row").first()).toBeVisible({
            timeout: 60_000,
        });
        await expect(page.getByTestId("recording-row")).toHaveCount(
            recordingCount,
        );
    } finally {
        await app.close();
    }

    // Rollback puts the previous (empty) data back: no recordings.
    const rolledBack = cli(dataDir, ["--rollback-import"]);
    expect(rolledBack.status, rolledBack.stderr).toBe(0);
    app = await launch(dataDir);
    try {
        const page = await dashboard(app);
        await openRecordings(page);
        await expect(page.getByTestId("recording-row")).toHaveCount(0, {
            timeout: 60_000,
        });
    } finally {
        await app.close();
    }
});
