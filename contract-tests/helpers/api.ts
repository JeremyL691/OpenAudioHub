import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type APIRequestContext, expect, request } from "@playwright/test";

export interface Credentials {
    email: string;
    password: string;
    name: string;
}

export const baseURL = process.env.OAH_BASE_URL ?? "http://localhost:3210";

/** Saved main-account session, one folder per server port so parallel runs do not collide. */
export const storageStatePath = resolve(
    __dirname,
    `../../.dev-artifacts/contract-auth-${new URL(baseURL).port || "default"}/user.json`,
);
/**
 * A random client address for one request context. Auth endpoints rate-limit per
 * client address, and every test talks from the same machine, so each context
 * presents its own address to get its own bucket.
 */
export function clientHeaders(): Record<string, string> {
    const n = () => Math.floor(Math.random() * 250) + 1;
    return { origin: baseURL, "x-forwarded-for": `10.${n()}.${n()}.${n()}` };
}

export const fakeAiBaseUrl =
    process.env.OAH_FAKE_AI_URL ?? "http://127.0.0.1:3299/v1";

/** The main account. The password comes from the run script; the fallback is only for local runs. */
export function credentials(): Credentials {
    return {
        email: process.env.OAH_EMAIL ?? "contract@openaudiohub.test",
        password: process.env.OAH_PASSWORD ?? "contract-password-1",
        name: "Contract User",
    };
}

/** A unique second account, for isolation tests. */
export function freshCredentials(label: string): Credentials {
    const id = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    return {
        email: `${label}-${id}@openaudiohub.test`,
        password: `pw-${id}-long-enough`,
        name: `${label} ${id}`,
    };
}

export async function signUpAndIn(
    api: APIRequestContext,
    who: Credentials,
): Promise<void> {
    await api.post("/api/auth/sign-up/email", { data: who });
    const res = await api.post("/api/auth/sign-in/email", {
        data: { email: who.email, password: who.password },
    });
    expect(res.status(), "sign-in").toBe(200);
}

/** A new request context signed in as a new user. Caller disposes it. */
export async function newUserContext(
    label: string,
): Promise<APIRequestContext> {
    const api = await request.newContext({
        baseURL,
        extraHTTPHeaders: clientHeaders(),
    });
    await signUpAndIn(api, freshCredentials(label));
    return api;
}

/** An anonymous request context. Caller disposes it. */
export async function anonymousContext(): Promise<APIRequestContext> {
    return request.newContext({
        baseURL,
        extraHTTPHeaders: clientHeaders(),
        storageState: { cookies: [], origins: [] },
    });
}

/** Test-only control call to the fake AI server (see fakes/fake-ai.mjs). */
export async function fakeAiControl(path: string, body: Record<string, unknown> = {}): Promise<void> {
    const origin = fakeAiBaseUrl.replace(/\/v1$/, "");
    const res = await fetch(`${origin}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`fake AI control ${path} failed: ${res.status}`);
}

export interface FakeAiRequest {
    seq: number;
    method: string;
    path: string;
    fields: Record<string, string>;
    json: { messages?: string; [key: string]: unknown } | null;
}

/** Requests the fake AI server received, newest last. `path` keeps only matching ones. */
export async function fakeAiRequests(path?: string): Promise<FakeAiRequest[]> {
    const origin = fakeAiBaseUrl.replace(/\/v1$/, "");
    const query = path ? `?path=${encodeURIComponent(path)}` : "";
    const res = await fetch(`${origin}/__requests${query}`);
    return (await res.json()) as FakeAiRequest[];
}

/** Marks onboarding done and points AI at the fake provider. Idempotent. */
export async function configureAccount(api: APIRequestContext): Promise<void> {
    const put = await api.put("/api/settings/user", {
        data: { onboardingCompleted: true },
    });
    expect(put.ok(), "complete onboarding").toBeTruthy();
    const list = await api.get("/api/settings/ai/providers");
    const body = (await list.json()) as { providers?: unknown[] };
    if ((body.providers ?? []).length > 0) return;
    const add = await api.post("/api/settings/ai/providers", {
        data: {
            provider: "Custom",
            apiKey: "contract-local-key",
            baseUrl: fakeAiBaseUrl,
            defaultModel: "fake-whisper-1",
            isDefaultTranscription: true,
            isDefaultEnhancement: true,
        },
    });
    expect(add.ok(), "add fake AI provider").toBeTruthy();
}

export function fixture(name: string): Buffer {
    return readFileSync(resolve(__dirname, "../fixtures", name));
}

/**
 * Uploads a fixture file under a unique name and returns the new recording id.
 * The upload response only echoes the title, so the id is looked up by title.
 */
export async function uploadRecording(
    api: APIRequestContext,
    file = "tone-3s.mp3",
    mimeType = "audio/mpeg",
): Promise<string> {
    const ext = file.slice(file.lastIndexOf("."));
    const title = `contract-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const res = await api.post("/api/recordings/upload", {
        multipart: {
            file: { name: `${title}${ext}`, mimeType, buffer: fixture(file) },
        },
    });
    expect(res.status(), "upload").toBeLessThan(300);
    const list = await api.get("/api/recordings");
    expect(list.ok(), "list after upload").toBeTruthy();
    const body = (await list.json()) as {
        recordings: { id: string; filename: string }[];
    };
    const found = body.recordings.find((r) => r.filename === title);
    expect(found, `uploaded recording "${title}" is listed`).toBeTruthy();
    return (found as { id: string }).id;
}
