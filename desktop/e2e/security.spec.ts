/**
 * Security regression for the packaged app (PLAN T16.5). It runs against a test build like electron.spec.ts, on a
 * data directory and ports of its own. Secret values are read from the test's data directory and only searched
 * for; no assertion message ever includes one. The fuse state is checked in the release build by
 * desktop/scripts/verify-bundle.mjs and recorded in DESKTOP_REPORT.md.
 */
import { spawnSync } from "node:child_process";
import { request } from "node:http";
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    type ElectronApplication,
    _electron as electron,
    expect,
    test,
} from "@playwright/test";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const appBundle = process.env.OAH_SMOKE_APP
    ? resolve(process.env.OAH_SMOKE_APP)
    : null;
const executable = appBundle
    ? join(appBundle, "Contents", "MacOS", "OpenAudioHub")
    : "";
const LAUNCH_TIMEOUT = 240_000;
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const PORTS = { app: 38800, pipeline: 38801, postgres: 38802 };

test.skip(
    !appBundle,
    "set OAH_SMOKE_APP to the test build's OpenAudioHub.app (dist --test-fuses)",
);
test.describe.configure({ mode: "serial", timeout: 600_000 });

const dataDir = join(
    repoRoot,
    ".dev-artifacts",
    "desktop-userdata",
    `e2e-security-${runId}`,
);

/** Secret values, read from the data directory. They are only compared, never printed. */
function secretValues(): string[] {
    const secrets = JSON.parse(
        readFileSync(join(dataDir, "secrets.json"), "utf8"),
    ) as Record<string, unknown>;
    return Object.entries(secrets)
        .filter(([key, value]) => key !== "schemaVersion" && typeof value === "string")
        .map(([, value]) => value as string);
}

function filesUnder(dir: string): string[] {
    if (!existsSync(dir)) return [];
    const found: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) found.push(...filesUnder(path));
        else if (entry.isFile()) found.push(path);
    }
    return found;
}

function mode(path: string): number {
    return statSync(path).mode & 0o777;
}

/** Listening sockets on the App's ports, as lsof reports them (one line per socket). */
function listeners(port: number): string[] {
    const run = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], {
        encoding: "utf8",
    });
    return run.stdout.split("\n").slice(1).filter(Boolean);
}

/** A raw request with a chosen Host header (fetch does not let a page set Host). */
function rawRequest(
    port: number,
    headers: Record<string, string>,
): Promise<number> {
    return new Promise((done, fail) => {
        const req = request(
            {
                host: "127.0.0.1",
                port,
                path: "/api/desktop/session",
                method: "POST",
                headers,
            },
            (res) => {
                res.resume();
                done(res.statusCode ?? 0);
            },
        );
        req.on("error", fail);
        req.end();
    });
}

let app: ElectronApplication | null = null;

test.beforeAll(() => {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(
        join(dataDir, "config.json"),
        JSON.stringify({ schemaVersion: 1, ports: PORTS }),
        { mode: 0o600 },
    );
});

test.afterAll(async () => {
    if (app) await app.close().catch(() => undefined);
});

test("the App listens only on the loopback address", async () => {
    app = await electron.launch({
        executablePath: executable,
        args: [],
        env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: process.env.HOME ?? "",
            TZ: "UTC",
            OAH_USER_DATA_DIR: dataDir,
            OAH_SKIP_MOVE_TO_APPLICATIONS: "1",
        },
        timeout: LAUNCH_TIMEOUT,
    });
    const page = await app.firstWindow({ timeout: LAUNCH_TIMEOUT });
    await page.waitForURL(/\/dashboard/, { timeout: LAUNCH_TIMEOUT });

    for (const port of Object.values(PORTS)) {
        const lines = listeners(port);
        expect(lines.length, `port ${port} is listening`).toBeGreaterThan(0);
        for (const line of lines) {
            // lsof's NAME column ends with the address and port: 127.0.0.1:<port> or [::1]:<port>.
            expect(
                /(127\.0\.0\.1|\[::1\]):\d+ \(LISTEN\)$/.test(line.trim()),
                `port ${port} is bound to loopback only`,
            ).toBe(true);
        }
    }
});

test("the database requires scram and the private files have private modes", async () => {
    const pgHba = readFileSync(join(dataDir, "pgdata", "pg_hba.conf"), "utf8")
        .split("\n")
        .filter((line) => line.trim() && !line.trimStart().startsWith("#"));
    expect(pgHba.length).toBeGreaterThan(0);
    expect(pgHba.some((line) => /\btrust\b/.test(line))).toBe(false);
    expect(
        pgHba.every((line) => /scram-sha-256\s*$/.test(line.trim())),
    ).toBe(true);

    expect(mode(join(dataDir, "secrets.json"))).toBe(0o600);
    expect(mode(join(dataDir, "config.json"))).toBe(0o600);
    expect(mode(dataDir)).toBe(0o700);
    expect(mode(join(dataDir, "pgdata"))).toBe(0o700);
    expect(mode(join(dataDir, "logs"))).toBe(0o700);
});

test("no secret value appears in any log", async () => {
    const values = secretValues();
    expect(values.length).toBeGreaterThan(0);
    const logs = filesUnder(join(dataDir, "logs"));
    expect(logs.length).toBeGreaterThan(0);
    for (const file of logs) {
        const text = readFileSync(file, "utf8");
        const leaked = values.some((value) => value.length >= 16 && text.includes(value));
        // Only the file's name is reported: the text itself must not be printed.
        expect(leaked, `secret value found in ${file.split("/").pop()}`).toBe(false);
    }
});

test("the session route refuses a wrong Host and a wrong bearer", async () => {
    // The App's own origin is 127.0.0.1:<app port>; anything else in Host is refused (403).
    const wrongHost = await rawRequest(PORTS.app, {
        Host: "evil.example",
        Authorization: "Bearer not-the-secret",
    });
    expect(wrongHost).toBe(403);
    // The right Host with a wrong bearer is refused as unauthorized (401).
    const wrongBearer = await rawRequest(PORTS.app, {
        Host: `127.0.0.1:${PORTS.app}`,
        Authorization: "Bearer not-the-secret",
    });
    expect(wrongBearer).toBe(401);
});

test("development-only routes answer 404 to a signed-in page (F24)", async () => {
    // The first test left the app running with its window open, so the page is already signed in.
    expect(app, "the app from the first test is running").not.toBeNull();
    const page = await app!.firstWindow({ timeout: LAUNCH_TIMEOUT });
    const apiStatus = await page.evaluate(
        async () => (await fetch("/api/dev/plaud/info")).status,
    );
    expect(apiStatus).toBe(404);
    const pageResponse = await page.goto(
        new URL("/dev/demo-dashboard", page.url()).toString(),
    );
    expect(pageResponse?.status()).toBe(404);
});
