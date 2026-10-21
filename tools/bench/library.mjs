#!/usr/bin/env node
// Measures the library list and the transcript search at a chosen library size.
//
//   node tools/bench/library.mjs [count]
//
// It starts a throwaway server in .dev-artifacts/bench-library/ on its own port, creates one
// account, and gives it `count` recordings (default 5000) with a mix of short notes, meeting
// transcripts and a few long ones. Both routes are then measured over 30 requests after a warm
// up, and the server's peak memory is read from the process.
//
// The data goes in through the API, not by writing the database: a recording is uploaded with a
// tiny audio fixture, then transcribed through the fake provider. That way the stored text is
// encrypted by the server exactly as a real library is, which is what makes the measurement
// mean something.
//
// Everything stays in .dev-artifacts/bench-library/, so the app you run is never touched.
import { spawn } from "node:child_process";
import { createReadStream, mkdirSync, readFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

const COUNT = Number(process.argv[2] ?? 5000);
const PORT = Number(process.env.OAH_BENCH_LIBRARY_PORT ?? 3292);
const FAKE_PORT = Number(process.env.OAH_BENCH_FAKE_PORT ?? 3293);
const ROOT = resolve(import.meta.dirname, "../..");
const ART = resolve(ROOT, ".dev-artifacts/bench-library");
const DATA = resolve(ART, "data");
const BASE = `http://127.0.0.1:${PORT}`;
const FAKE = `http://127.0.0.1:${FAKE_PORT}`;
const EMAIL = `bench-${Date.now()}@openaudiohub.test`;
const PASSWORD = "bench-password-1";
const FIXTURE = resolve(ROOT, "contract-tests/fixtures/tone-3s.mp3");

function script(i) {
    // A realistic spread: mostly short notes, some meetings, a few long recordings.
    const shape = i % 10;
    const words = shape < 3 ? 30 : shape < 8 ? 350 : 1800;
    const parts = Array.from({ length: words }, (_, w) => {
        const hit = w === 11 && i % 7 === 0 ? " needle" : "";
        return `word${w % 97}${hit}`;
    });
    return `Benchmark recording ${i}. ${parts.join(" ")}`;
}

async function main() {
    rmSync(DATA, { recursive: true, force: true });
    mkdirSync(DATA, { recursive: true });

    const fake = spawn(process.execPath, [resolve(ROOT, "contract-tests/fakes/fake-ai.mjs"), String(FAKE_PORT)], {
        stdio: ["ignore", "ignore", "inherit"],
    });
    const server = spawn(resolve(ROOT, "target/debug/oah-server"), [], {
        env: {
            ...process.env,
            OAH_DATA_DIR: DATA,
            PORT: String(PORT),
            HOST: "127.0.0.1",
            APP_URL: BASE,
            ENCRYPTION_KEY: randomBytes(32).toString("hex"),
            RATE_LIMIT_TRUST_PROXY_HEADERS: "true",
            WEBHOOKS_REQUIRE_PUBLIC_TARGETS: "false",
            // The pipeline would run ffmpeg and speech detection per recording; the synchronous
            // path keeps seeding to the provider call that matters here.
            AUDIO_PIPELINE_ENABLED: "false",
        },
        stdio: ["ignore", "ignore", "inherit"],
    });
    const stop = () => {
        server.kill();
        fake.kill();
    };
    process.on("exit", stop);

    const wait = async (url) => {
        for (let i = 0; i < 240; i++) {
            try {
                if ((await fetch(url)).ok) return;
            } catch {}
            await new Promise((r) => setTimeout(r, 250));
        }
        throw new Error(`timed out waiting for ${url}`);
    };
    await wait(`${BASE}/api/health`);
    await wait(`${FAKE}/v1/models`);

    const jar = [];
    const call = async (path, init = {}) => {
        const res = await fetch(`${BASE}${path}`, {
            ...init,
            headers: {
                origin: BASE,
                cookie: jar.join("; "),
                ...(init.headers ?? {}),
            },
        });
        for (const c of res.headers.getSetCookie?.() ?? []) jar.push(c.split(";")[0]);
        return res;
    };
    const json = async (path, body) => {
        const res = await call(path, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
        return res.json();
    };

    await json("/api/auth/sign-up/email", { name: "Bench", email: EMAIL, password: PASSWORD });
    await call("/api/settings/user", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ onboardingCompleted: true }),
    });
    await json("/api/settings/ai/providers", {
        provider: "Custom",
        apiKey: "bench",
        baseUrl: `${FAKE}/v1`,
        defaultModel: "fake-whisper-1",
        isDefaultTranscription: true,
        isDefaultEnhancement: true,
    });
    console.error(`seeding ${COUNT} recordings…`);
    // The upload answer carries no id, so the new one is the id not seen before. The list is
    // read once per upload, which is what keeps seeding linear rather than quadratic.
    let known = new Set((await (await call("/api/recordings")).json()).recordings.map((r) => r.id));
    const bytes = readFileSync(FIXTURE);

    for (let i = 0; i < COUNT; i++) {
        const form = new FormData();
        form.append("file", new Blob([bytes], { type: "audio/mpeg" }), `bench-${i}.mp3`);
        const up = await call("/api/recordings/upload", { method: "POST", body: form });
        if (!up.ok) throw new Error(`upload ${i}: ${up.status}`);
        const rows = (await (await call("/api/recordings")).json()).recordings;
        const row = rows.find((r) => !known.has(r.id));
        if (!row) throw new Error(`upload ${i} created no recording`);
        known = new Set(rows.map((r) => r.id));
        const tr = await call(`/api/recordings/${row.id}/transcribe`, { method: "POST" });
        if (tr.status !== 200 && tr.status !== 202) throw new Error(`transcribe ${i}: ${tr.status}`);
        if (i % 100 === 0) console.error(`  ${i}/${COUNT}`);
    }

    const time = async (path) => {
        const start = performance.now();
        const res = await call(path);
        const body = await res.text();
        return { ms: performance.now() - start, bytes: body.length, status: res.status };
    };
    const stats = (xs) => {
        const s = [...xs].sort((a, b) => a - b);
        const at = (p) => s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
        return { p50: at(0.5), p95: at(0.95) };
    };

    for (let i = 0; i < 5; i++) await time("/api/recordings");
    const list = [];
    let listBytes = 0;
    for (let i = 0; i < 30; i++) {
        const r = await time("/api/recordings");
        list.push(r.ms);
        listBytes = r.bytes;
    }

    const query = encodeURIComponent("needle");
    for (let i = 0; i < 5; i++) await time(`/api/recordings/search?q=${query}`);
    const search = [];
    let searchBytes = 0;
    let status = 0;
    for (let i = 0; i < 30; i++) {
        const r = await time(`/api/recordings/search?q=${query}`);
        search.push(r.ms);
        searchBytes = r.bytes;
        status = r.status;
    }

    let rss = 0;
    try {
        rss = Number(readFileSync(`/proc/${server.pid}/status`, "utf8").match(/VmHWM:\s+(\d+)/)?.[1] ?? 0);
    } catch {
        rss = 0;
    }

    const l = stats(list);
    const s = stats(search);
    console.log(`| ${COUNT} | ${l.p50.toFixed(0)} | ${l.p95.toFixed(0)} | ${(listBytes / 1024).toFixed(0)} | ${s.p50.toFixed(0)} | ${s.p95.toFixed(0)} | ${status} | ${rss ? (rss / 1024).toFixed(0) : "n/a"} |`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
