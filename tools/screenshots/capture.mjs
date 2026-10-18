// Seeds demo data through the public HTTP API, then captures the README screenshots.
// Env: BASE_URL, FAKE_AI_URL, OUT_DIR (images), WORK_DIR (scratch audio).
import { createRequire } from "node:module";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DEMO_RECORDINGS } from "./demo-data.mjs";

// The browser test package is installed with the contract suite; reuse it rather than adding a second copy.
const require = createRequire(new URL("../../contract-tests/package.json", import.meta.url));
const { chromium, request } = require("@playwright/test");

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3290";
const FAKE_AI_URL = process.env.FAKE_AI_URL ?? "http://127.0.0.1:3291/v1";
const OUT_DIR = process.env.OUT_DIR ?? join(process.cwd(), "docs/images");
const WORK_DIR = process.env.WORK_DIR ?? join(process.cwd(), ".dev-artifacts/screenshots-audio");
const MAX_BYTES = 1.5 * 1024 * 1024;
const VIEWPORT = { width: 1440, height: 900 };

const SHOTS = [
    { file: "dashboard.png", path: "/dashboard" },
    { file: "library.png", path: "/recordings", select: "Onboarding Design Review" },
    { file: "recording.png", path: "/recordings/:id" },
    { file: "settings.png", path: "/settings/providers" },
];

function fail(message) {
    throw new Error(message);
}

/** A short speech-like tone: bursts of voiced sound with pauses, so the waveform looks like a conversation. */
function speechLikeWav(seconds, seed) {
    const rate = 16000;
    const samples = rate * seconds;
    const data = Buffer.alloc(samples * 2);
    let state = seed >>> 0;
    const rand = () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 4294967296;
    };
    let level = 0;
    let target = 0;
    let nextChange = 0;
    for (let i = 0; i < samples; i++) {
        if (i >= nextChange) {
            target = rand() < 0.7 ? 0.35 + 0.6 * rand() : 0.02;
            nextChange = i + Math.floor(rate * (0.4 + 1.6 * rand()));
        }
        level += (target - level) * 0.0005;
        const t = i / rate;
        const voice = 0.55 * Math.sin(2 * Math.PI * 140 * t) + 0.3 * Math.sin(2 * Math.PI * 310 * t + Math.sin(3 * t)) + 0.12 * (rand() * 2 - 1);
        const value = Math.max(-1, Math.min(1, level * voice * 0.8));
        data.writeInt16LE(Math.round(value * 32767), i * 2);
    }
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + data.length, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(rate, 24);
    header.writeUInt32LE(rate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(data.length, 40);
    return Buffer.concat([header, data]);
}

async function json(res, what) {
    if (!res.ok()) fail(`${what} failed with HTTP ${res.status()}: ${await res.text()}`);
    return res.json();
}

async function listRecordings(api) {
    return (await json(await api.get("/api/recordings"), "list recordings")).recordings;
}

/** Waits until a background transcription job (HTTP 202) reaches a final state. */
async function waitForPipeline(api, id) {
    const finalStates = ["completed", "needs_alignment", "failed", "cancelled"];
    for (let i = 0; i < 240; i++) {
        const state = await (await api.get(`/api/recordings/${id}/audio-pipeline`)).json();
        if (finalStates.includes(state.job?.status ?? "none")) return;
        await new Promise((r) => setTimeout(r, 500));
    }
    fail(`transcription of ${id} did not finish`);
}

async function seed(api, audioDir) {
    const password = `demo-${randomUUID()}`;
    await json(
        await api.post("/api/auth/sign-up/email", { data: { name: "Alex Morgan", email: "alex@example.com", password } }),
        "sign up",
    );
    await json(await api.post("/api/auth/sign-in/email", { data: { email: "alex@example.com", password } }), "sign in");
    await json(await api.put("/api/settings/user", { data: { onboardingCompleted: true } }), "complete onboarding");
    await json(
        await api.post("/api/settings/ai/providers", {
            data: {
                provider: "Custom",
                apiKey: "demo-local-key",
                baseUrl: FAKE_AI_URL,
                defaultModel: "demo-chat-1",
                isDefaultTranscription: true,
                isDefaultEnhancement: true,
            },
        }),
        "add AI provider",
    );

    // Oldest first, so the library (newest first) lists them in the order of DEMO_RECORDINGS.
    for (const demo of [...DEMO_RECORDINGS].reverse()) {
        const basename = `${demo.slug}-${Date.now()}`;
        const buffer = speechLikeWav(demo.lines.length * 18, demo.slug.length * 7919);
        writeFileSync(join(audioDir, `${basename}.wav`), buffer);
        await json(
            await api.post("/api/recordings/upload", {
                multipart: { file: { name: `${basename}.wav`, mimeType: "audio/wav", buffer } },
            }),
            `upload ${demo.title}`,
        );
        const row = (await listRecordings(api)).find((r) => r.filename === basename);
        if (!row) fail(`uploaded ${demo.title} is not listed`);
        await json(await api.patch(`/api/recordings/${row.id}`, { data: { filename: demo.title } }), `rename ${demo.title}`);
        if (demo.starred) {
            await json(await api.put(`/api/recordings/${row.id}/star`, { data: { starred: true } }), `star ${demo.title}`);
        }
        const transcribe = await api.post(`/api/recordings/${row.id}/transcribe`, { data: {} });
        if (transcribe.status() === 202) await waitForPipeline(api, row.id);
        else if (!transcribe.ok()) fail(`transcribe ${demo.title} failed with HTTP ${transcribe.status()}`);
        await json(await api.post(`/api/recordings/${row.id}/summary`, { data: {} }), `summarize ${demo.title}`);
    }
    const byTitle = Object.fromEntries((await listRecordings(api)).map((r) => [r.filename, r.id]));
    return byTitle;
}

/** Points the demo provider at a generic endpoint, so the settings screenshot does not show the local stub. */
async function showGenericProviderEndpoint(api) {
    const list = await json(await api.get("/api/settings/ai/providers"), "list AI providers");
    const demo = list.providers.find((p) => p.baseUrl === FAKE_AI_URL);
    if (!demo) fail("the demo provider is not listed");
    await json(
        await api.put(`/api/settings/ai/providers/${demo.id}`, {
            data: {
                baseUrl: "https://api.example.com/v1",
                defaultModel: demo.defaultModel,
                isDefaultTranscription: true,
                isDefaultEnhancement: true,
            },
        }),
        "set the demo provider endpoint",
    );
}

/** Closes the first-run dialog the way a user does, if it is showing. */
async function dismissOnboarding(page) {
    const dialog = page.getByTestId("onboarding-dialog");
    for (let i = 0; i < 6 && (await dialog.isVisible().catch(() => false)); i++) {
        const finish = dialog.getByRole("button", { name: "Get Started" });
        if (await finish.isVisible().catch(() => false)) {
            await finish.click();
            break;
        }
        await dialog.getByRole("button", { name: "Next" }).click();
    }
    await dialog.waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
}

async function capture(browser, storageState, outDir, scale, ids) {
    const context = await browser.newContext({
        baseURL: BASE_URL,
        viewport: VIEWPORT,
        deviceScaleFactor: scale,
        colorScheme: "light",
        locale: "en-US",
        storageState,
    });
    await context.addInitScript(() => {
        try {
            localStorage.setItem("theme", "light");
        } catch {}
    });
    const page = await context.newPage();
    const sizes = [];
    for (const shot of SHOTS) {
        const url = shot.path.replace(":id", ids.recording);
        await page.goto(url, { waitUntil: "networkidle" });
        await dismissOnboarding(page);
        if (shot.select) {
            const row = page.locator('[data-testid="recording-row"]', { hasText: shot.select }).first();
            await row.waitFor({ state: "visible", timeout: 15000 });
            await row.click();
            await page.locator(`[data-testid="recording-row"][data-id="${ids[shot.select]}"][data-selected="true"]`).waitFor({ timeout: 15000 });
        }
        await page.evaluate(() => document.fonts.ready);
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(800);
        const file = join(outDir, shot.file);
        await page.screenshot({ path: file, type: "png", animations: "disabled" });
        sizes.push({ file: shot.file, bytes: statSync(file).size });
    }
    await context.close();
    return sizes;
}

async function main() {
    mkdirSync(OUT_DIR, { recursive: true });
    mkdirSync(WORK_DIR, { recursive: true });
    const api = await request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { origin: BASE_URL } });
    const titleIds = await seed(api, WORK_DIR);
    await showGenericProviderEndpoint(api);
    const storageState = await api.storageState();
    await api.dispose();

    const ids = { recording: titleIds["Q4 Planning Sync"] };
    for (const [title, id] of Object.entries(titleIds)) ids[title] = id;
    if (!ids.recording) fail("Q4 Planning Sync was not seeded");

    const browser = await chromium.launch();
    try {
        // Quality first at 2x. Fall back to 1.5x only if a PNG is over the size budget.
        for (const scale of [2, 1.5]) {
            const sizes = await capture(browser, storageState, OUT_DIR, scale, ids);
            const report = sizes.map((s) => `${s.file} ${(s.bytes / 1024).toFixed(0)} KB`).join(", ");
            console.log(`captured at ${scale}x: ${report}`);
            if (sizes.every((s) => s.bytes <= MAX_BYTES)) return;
        }
        fail("an image is still over 1.5 MB at 1.5x");
    } finally {
        await browser.close();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
