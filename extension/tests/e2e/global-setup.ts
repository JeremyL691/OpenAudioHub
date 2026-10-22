import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { request } from "@playwright/test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const artifacts = resolve(repoRoot, ".dev-artifacts");
const stateFile = resolve(artifacts, "extension-e2e-state.json");
const dataDir = resolve(artifacts, "extension-e2e-data");
const serverPort = 3290;
const fakePort = 3298;
const baseUrl = `http://127.0.0.1:${serverPort}`;

interface State {
    serverPid?: number;
    fakePid?: number;
}

async function ready(url: string): Promise<boolean> {
    const context = await request.newContext();
    try {
        return (await context.get(url)).ok();
    } catch {
        return false;
    } finally {
        await context.dispose();
    }
}

async function waitFor(url: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
        if (Date.now() >= deadline) break;
        if (await ready(url)) return true;
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
}

export default async function globalSetup(): Promise<void> {
    await mkdir(artifacts, { recursive: true });
    await rm(dataDir, { recursive: true, force: true });
    const state: State = {};

    const build = spawnSync("cargo", ["build", "-q", "--bin", "oah-server"], { cwd: repoRoot, stdio: "inherit" });
    if (build.status !== 0) throw new Error("server build failed");

    if (!(await ready(`http://127.0.0.1:${fakePort}/__control/health`))) {
        const fake = spawn(process.execPath, [resolve(repoRoot, "contract-tests/fakes/fake-plaud.mjs"), String(fakePort)], {
            stdio: "ignore",
        });
        state.fakePid = fake.pid;
        if (!(await waitFor(`http://127.0.0.1:${fakePort}/__control/health`, 20_000))) {
            throw new Error("fake Plaud API did not start");
        }
    }
    const control = await request.newContext();
    await control.post(`http://127.0.0.1:${fakePort}/__control/reset`);
    await control.dispose();

    if (await ready(`${baseUrl}/api/health`)) {
        throw new Error(`a server is already listening on ${baseUrl}`);
    }
    const server = spawn(resolve(repoRoot, "target/debug/oah-server"), {
        cwd: repoRoot,
        env: {
            ...process.env,
            OAH_DATA_DIR: dataDir,
            PORT: String(serverPort),
            HOST: "127.0.0.1",
            APP_URL: baseUrl,
            ENCRYPTION_KEY: "6e9d3c2b8a745f01c3d5e7a9b2c4d6e8f0a1b3c5d7e9f1a3b5c7d9e1f3a5b7c9",
            OAH_SESSION_COOKIE: "oah_session",
            OAH_PLAUD_API_BASE: `http://127.0.0.1:${fakePort}`,
            AUDIO_PIPELINE_ENABLED: "false",
            RATE_LIMIT_TRUST_PROXY_HEADERS: "true",
            OAH_MULTI_USER: "true",
        },
        stdio: "ignore",
    });
    state.serverPid = server.pid;
    await writeFile(stateFile, JSON.stringify(state));
    if (!(await waitFor(`${baseUrl}/api/health`, 60_000))) {
        throw new Error("OpenAudioHub server did not start");
    }
}

