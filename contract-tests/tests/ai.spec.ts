import { randomUUID } from "node:crypto";
import { type APIRequestContext, expect, test } from "@playwright/test";
import {
    anonymousContext,
    fakeAiBaseUrl,
    newUserContext,
    uploadRecording,
} from "../helpers/api";

interface ProviderRow {
    id: string;
    provider: string;
    baseUrl: string | null;
    defaultModel: string | null;
    isDefaultTranscription: boolean;
    isDefaultEnhancement: boolean;
}

const KEY = "contract-ai-test-key-7f3a";
const SUMMARY_TEXT = "Contract summary: a short fixed answer.";

const contexts: APIRequestContext[] = [];

async function user(label: string): Promise<APIRequestContext> {
    const api = await newUserContext(label);
    contexts.push(api);
    return api;
}

test.afterEach(async () => {
    await Promise.all(contexts.splice(0).map((api) => api.dispose()));
});

async function addProvider(
    api: APIRequestContext,
    body: Record<string, unknown> = {},
): Promise<ProviderRow> {
    const res = await api.post("/api/settings/ai/providers", {
        data: {
            provider: "Custom",
            apiKey: KEY,
            baseUrl: fakeAiBaseUrl,
            defaultModel: "fake-chat-1",
            isDefaultTranscription: true,
            isDefaultEnhancement: true,
            ...body,
        },
    });
    expect(res.status(), "create provider").toBe(200);
    return ((await res.json()) as { provider: ProviderRow }).provider;
}

async function listProviders(api: APIRequestContext): Promise<ProviderRow[]> {
    const res = await api.get("/api/settings/ai/providers");
    expect(res.status(), "list providers").toBe(200);
    return ((await res.json()) as { providers: ProviderRow[] }).providers;
}

/** Uploads first (no provider yet, so nothing transcribes it), then adds the fake provider and transcribes. */
async function transcribedRecording(api: APIRequestContext): Promise<string> {
    const id = await uploadRecording(api);
    await addProvider(api);
    const res = await api.post(`/api/recordings/${id}/transcribe`);
    expect(res.status(), "transcribe").toBe(200);
    const body = (await res.json()) as { transcription?: string };
    expect(body.transcription, "transcript text").toBeTruthy();
    return id;
}

async function waitFor<T>(
    read: () => Promise<T | undefined>,
    timeoutMs = 30_000,
): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await read();
        if (value !== undefined) return value;
        if (Date.now() > deadline) throw new Error("timed out waiting");
        await new Promise((r) => setTimeout(r, 500));
    }
}

test.describe("provider settings", () => {
    test("a new user has no providers", async () => {
        const api = await user("ai-empty");
        expect(await listProviders(api)).toEqual([]);
    });

    test("create answers with the provider and never with the key", async () => {
        const api = await user("ai-create");
        const res = await api.post("/api/settings/ai/providers", {
            data: {
                provider: "Custom",
                apiKey: KEY,
                baseUrl: fakeAiBaseUrl,
                defaultModel: "fake-chat-1",
            },
        });
        expect(res.status()).toBe(200);
        const text = await res.text();
        expect(text).not.toContain(KEY);
        const { provider } = JSON.parse(text) as { provider: ProviderRow };
        expect(provider.id).toBeTruthy();
        expect(provider.provider).toBe("Custom");
        expect(provider.baseUrl).toBe(fakeAiBaseUrl);
        expect(provider.defaultModel).toBe("fake-chat-1");
        expect(provider.isDefaultTranscription).toBe(false);
        expect(provider.isDefaultEnhancement).toBe(false);
    });

    test("list shows providers without any key, masked or not", async () => {
        const api = await user("ai-mask");
        await addProvider(api);
        const res = await api.get("/api/settings/ai/providers");
        const text = await res.text();
        expect(text).not.toContain(KEY);
        const [row] = JSON.parse(text).providers as Record<string, unknown>[];
        expect(row).not.toHaveProperty("apiKey");
    });

    test("a new default moves the default off the other provider", async () => {
        const api = await user("ai-default-move");
        const a = await addProvider(api);
        const b = await addProvider(api);
        const rows = await listProviders(api);
        const rowA = rows.find((r) => r.id === a.id);
        const rowB = rows.find((r) => r.id === b.id);
        expect(rowB?.isDefaultTranscription).toBe(true);
        expect(rowB?.isDefaultEnhancement).toBe(true);
        expect(rowA?.isDefaultTranscription).toBe(false);
        expect(rowA?.isDefaultEnhancement).toBe(false);
    });

    test("a missing key or provider name is refused", async () => {
        const api = await user("ai-missing");
        const noKey = await api.post("/api/settings/ai/providers", {
            data: { provider: "Custom" },
        });
        expect(noKey.status()).toBe(400);
        expect((await noKey.json()).code).toBe("MISSING_REQUIRED_FIELD");

        const noName = await api.post("/api/settings/ai/providers", {
            data: { apiKey: KEY },
        });
        expect(noName.status()).toBe(400);
        expect((await noName.json()).code).toBe("MISSING_REQUIRED_FIELD");
    });

    test("ElevenLabs cannot be the enhancement default", async () => {
        const api = await user("ai-el-enh");
        const res = await api.post("/api/settings/ai/providers", {
            data: {
                provider: "ElevenLabs",
                apiKey: KEY,
                isDefaultEnhancement: true,
            },
        });
        expect(res.status()).toBe(400);
        const body = await res.json();
        expect(body.code).toBe("INVALID_INPUT");
    });

    test("OpenCode Go cannot be the transcription default", async () => {
        const api = await user("ai-oc-tr");
        const res = await api.post("/api/settings/ai/providers", {
            data: {
                provider: "OpenCode Go",
                apiKey: KEY,
                isDefaultTranscription: true,
            },
        });
        expect(res.status()).toBe(400);
        const body = await res.json();
        expect(body.code).toBe("INVALID_INPUT");
        expect(body.details).toEqual({ field: "isDefaultTranscription" });
    });

    test("OpenCode Go can be saved for summaries only", async () => {
        const api = await user("ai-oc-ok");
        const provider = await addProvider(api, {
            provider: "OpenCode Go",
            baseUrl: null,
            isDefaultTranscription: false,
        });
        expect(provider.provider).toBe("OpenCode Go");
        expect(provider.isDefaultTranscription).toBe(false);
    });

    test("update replaces fields and keeps the stored key when none is sent", async () => {
        const api = await user("ai-update");
        const p = await addProvider(api, { baseUrl: fakeAiBaseUrl });
        const res = await api.put(`/api/settings/ai/providers/${p.id}`, {
            data: {
                defaultModel: "fake-chat-1",
                isDefaultTranscription: true,
                isDefaultEnhancement: true,
            },
        });
        expect(res.status()).toBe(200);
        expect(await res.json()).toEqual({ success: true });

        const row = (await listProviders(api)).find((r) => r.id === p.id);
        // Fields not sent are cleared.
        expect(row?.baseUrl).toBeNull();
        expect(row?.defaultModel).toBe("fake-chat-1");
        expect(row?.isDefaultTranscription).toBe(true);

        // The stored key still works: the test endpoint uses it when no key is sent.
        const test = await api.post("/api/settings/ai/providers/test", {
            data: { id: p.id, baseUrl: fakeAiBaseUrl },
        });
        expect(test.status()).toBe(200);
        expect((await test.json()).ok).toBe(true);
    });

    test("update of an unknown provider is not found", async () => {
        const api = await user("ai-update-404");
        const res = await api.put(
            `/api/settings/ai/providers/${randomUUID()}`,
            { data: { defaultModel: "x" } },
        );
        expect(res.status()).toBe(404);
        expect((await res.json()).code).toBe("NOT_FOUND");
    });

    test("delete removes the provider", async () => {
        const api = await user("ai-delete");
        const p = await addProvider(api);
        const res = await api.delete(`/api/settings/ai/providers/${p.id}`);
        expect(res.status()).toBe(200);
        expect(await res.json()).toEqual({ success: true });
        expect((await listProviders(api)).some((r) => r.id === p.id)).toBe(
            false,
        );
    });

    test("delete of another user's provider changes nothing", async () => {
        const owner = await user("ai-owner");
        const other = await user("ai-other");
        const p = await addProvider(owner);
        const res = await other.delete(`/api/settings/ai/providers/${p.id}`);
        expect(res.status()).toBe(200);
        expect((await listProviders(owner)).some((r) => r.id === p.id)).toBe(
            true,
        );
    });

    test("the transcription default can be set by id", async () => {
        const api = await user("ai-dt");
        const a = await addProvider(api, { isDefaultTranscription: false });
        const b = await addProvider(api, { isDefaultTranscription: false });
        const res = await api.put("/api/settings/ai/providers/default-transcription", {
            data: { providerId: a.id },
        });
        expect(res.status()).toBe(200);
        expect(await res.json()).toEqual({ success: true });
        const rows = await listProviders(api);
        expect(rows.find((r) => r.id === a.id)?.isDefaultTranscription).toBe(
            true,
        );
        expect(rows.find((r) => r.id === b.id)?.isDefaultTranscription).toBe(
            false,
        );
    });

    test("the transcription default refuses unknown and chat-only providers", async () => {
        const api = await user("ai-dt-bad");
        const unknown = await api.put(
            "/api/settings/ai/providers/default-transcription",
            { data: { providerId: randomUUID() } },
        );
        expect(unknown.status()).toBe(404);
        expect((await unknown.json()).code).toBe("NOT_FOUND");

        const chatOnly = await addProvider(api, {
            provider: "OpenCode Go",
            baseUrl: null,
            isDefaultTranscription: false,
        });
        const refused = await api.put(
            "/api/settings/ai/providers/default-transcription",
            { data: { providerId: chatOnly.id } },
        );
        expect(refused.status()).toBe(400);
        expect((await refused.json()).code).toBe("INVALID_INPUT");

        const invalid = await api.put(
            "/api/settings/ai/providers/default-transcription",
            { data: {} },
        );
        expect(invalid.status()).toBe(400);
        expect((await invalid.json()).code).toBe("INVALID_INPUT");
    });

    test("transcription-capable and enhancement-capable presets accept both defaults", async () => {
        const api = await user("ai-presets");
        for (const name of ["OpenAI", "Groq", "OpenRouter", "Custom"]) {
            const res = await api.post("/api/settings/ai/providers", {
                data: {
                    provider: name,
                    apiKey: KEY,
                    isDefaultTranscription: true,
                    isDefaultEnhancement: true,
                },
            });
            expect(res.status(), name).toBe(200);
        }
    });

    test("provider routes need a session", async () => {
        const api = await anonymousContext();
        try {
            const res = await api.get("/api/settings/ai/providers");
            expect(res.status()).toBe(401);
            expect((await res.json()).code).toBe("AUTH_SESSION_MISSING");
        } finally {
            await api.dispose();
        }
    });
});

test.describe("provider test endpoint", () => {
    test("a request with neither key nor id is refused", async () => {
        const api = await user("ai-test-none");
        const res = await api.post("/api/settings/ai/providers/test", {
            data: { provider: "Custom", baseUrl: fakeAiBaseUrl },
        });
        expect(res.status()).toBe(400);
        expect((await res.json()).code).toBe("MISSING_REQUIRED_FIELD");
    });

    test("a saved provider is tested with its stored key", async () => {
        const api = await user("ai-test-saved");
        const p = await addProvider(api);
        const res = await api.post("/api/settings/ai/providers/test", {
            data: { id: p.id },
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.ok).toBe(true);
        expect(body.kind).toBe("chat");
        expect(typeof body.latencyMs).toBe("number");
    });

    test("a transcription model is tested as a transcription", async () => {
        const api = await user("ai-test-tr");
        const res = await api.post("/api/settings/ai/providers/test", {
            data: {
                provider: "Custom",
                apiKey: KEY,
                baseUrl: fakeAiBaseUrl,
                model: "fake-whisper-1",
            },
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.kind).toBe("transcription");
        expect(body.ok).toBe(true);
    });

    test("an unreachable endpoint is reported inside a 200 without the key", async () => {
        const api = await user("ai-test-down");
        const res = await api.post("/api/settings/ai/providers/test", {
            data: {
                provider: "Custom",
                apiKey: KEY,
                baseUrl: "http://127.0.0.1:9/v1",
                model: "fake-chat-1",
            },
        });
        expect(res.status()).toBe(200);
        const text = await res.text();
        const body = JSON.parse(text);
        expect(body.ok).toBe(false);
        expect(body.kind).toBe("chat");
        expect(typeof body.error).toBe("string");
        expect(body.error.length).toBeLessThanOrEqual(300);
        expect(text).not.toContain(KEY);
    });

    test("another user's provider id is not found", async () => {
        const owner = await user("ai-test-owner");
        const other = await user("ai-test-other");
        const p = await addProvider(owner);
        const res = await other.post("/api/settings/ai/providers/test", {
            data: { id: p.id },
        });
        expect(res.status()).toBe(404);
        expect((await res.json()).code).toBe("NOT_FOUND");
    });
});

test.describe("provider model list", () => {
    test("chat models come from the upstream, sorted and without excluded ids", async () => {
        const api = await user("ai-models-chat");
        const res = await api.post("/api/settings/ai/providers/models", {
            data: {
                provider: "SiliconFlow (China)",
                apiKey: KEY,
                baseUrl: fakeAiBaseUrl,
                kind: "chat",
            },
        });
        expect(res.status()).toBe(200);
        const { models } = (await res.json()) as {
            models: { id: string; name: string }[];
        };
        expect(models.map((m) => m.id)).toEqual(["fake-chat-1", "fake-whisper-1"]);
        for (const m of models) expect(m.name).toBe(m.id);
    });

    test("audio model list is empty for a provider without audio listing", async () => {
        const api = await user("ai-models-audio");
        for (const provider of ["Custom", "OpenRouter"]) {
            const res = await api.post("/api/settings/ai/providers/models", {
                data: { provider, apiKey: KEY, baseUrl: fakeAiBaseUrl },
            });
            expect(res.status(), provider).toBe(200);
            expect(await res.json()).toEqual({ models: [] });
        }
    });

    test("chat model list is empty for a provider without chat listing", async () => {
        const api = await user("ai-models-none");
        const res = await api.post("/api/settings/ai/providers/models", {
            data: {
                provider: "Custom",
                apiKey: KEY,
                baseUrl: fakeAiBaseUrl,
                kind: "chat",
            },
        });
        expect(res.status()).toBe(200);
        expect(await res.json()).toEqual({ models: [] });
    });

    test("model list needs a provider and a key", async () => {
        const api = await user("ai-models-400");
        const res = await api.post("/api/settings/ai/providers/models", {
            data: { provider: "Custom" },
        });
        expect(res.status()).toBe(400);
        expect((await res.json()).code).toBe("MISSING_REQUIRED_FIELD");
    });
});

test.describe("summaries", () => {
    test("a recording with no summary reports none and not generating", async () => {
        const api = await user("ai-sum-empty");
        const id = await uploadRecording(api);
        const res = await api.get(`/api/recordings/${id}/summary`);
        expect(res.status()).toBe(200);
        expect(await res.json()).toEqual({ summary: null, generating: false });
    });

    test("summarizing a recording without a transcript is refused", async () => {
        const api = await user("ai-sum-untranscribed");
        const id = await uploadRecording(api);
        const res = await api.post(`/api/recordings/${id}/summary`, { data: {} });
        expect(res.status()).toBe(400);
        expect((await res.json()).code).toBe("INVALID_INPUT");
    });

    test("summarizing without a usable provider is refused", async () => {
        const api = await user("ai-sum-noprov");
        const id = await uploadRecording(api);
        const p = await addProvider(api);
        const tr = await api.post(`/api/recordings/${id}/transcribe`);
        expect(tr.status()).toBe(200);
        expect((await api.delete(`/api/settings/ai/providers/${p.id}`)).status()).toBe(200);
        const res = await api.post(`/api/recordings/${id}/summary`, { data: {} });
        expect(res.status()).toBe(400);
        expect((await res.json()).code).toBe("AI_PROVIDER_NOT_CONFIGURED");
    });

    test("a summary from the fake provider is returned in full", async () => {
        const api = await user("ai-sum-gen");
        const id = await transcribedRecording(api);
        const res = await api.post(`/api/recordings/${id}/summary`, { data: {} });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.summary).toBe(SUMMARY_TEXT);
        expect(body.keyPoints).toEqual(["First point", "Second point"]);
        expect(body.actionItems).toEqual(["Follow up"]);
        expect(body.provider).toBe("Custom");
        expect(body.model).toBe("fake-chat-1");
        expect(body.promptId).toBe("general");
        expect(body.promptFallback).toBe(false);
        expect(body.language).toBe("auto");
    });

    test("GET returns the saved summary with its details", async () => {
        const api = await user("ai-sum-get");
        const id = await transcribedRecording(api);
        expect(
            (await api.post(`/api/recordings/${id}/summary`, { data: {} })).status(),
        ).toBe(200);
        const res = await api.get(`/api/recordings/${id}/summary`);
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.summary).toBe(SUMMARY_TEXT);
        expect(body.keyPoints).toEqual(["First point", "Second point"]);
        expect(body.actionItems).toEqual(["Follow up"]);
        expect(body.provider).toBe("Custom");
        expect(body.model).toBe("fake-chat-1");
        expect(body.promptId).toBe("general");
        expect(body.language).toBe("auto");
        expect(typeof body.createdAt).toBe("string");
        expect(body.generating).toBe(false);
    });

    test("a named preset is recorded as the prompt used", async () => {
        const api = await user("ai-sum-preset");
        const id = await transcribedRecording(api);
        const res = await api.post(`/api/recordings/${id}/summary`, {
            data: { preset: "key-points" },
        });
        const body = await res.json();
        expect(body.promptId).toBe("key-points");
        expect(body.promptFallback).toBe(false);
    });

    test("an unknown preset falls back to general and says so", async () => {
        const api = await user("ai-sum-fallback");
        const id = await transcribedRecording(api);
        const res = await api.post(`/api/recordings/${id}/summary`, {
            data: { preset: "no-such-prompt" },
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.promptId).toBe("general");
        expect(body.promptFallback).toBe(true);
    });

    test("a custom prompt saved in settings can be used", async () => {
        const api = await user("ai-sum-custom");
        const id = await transcribedRecording(api);
        const put = await api.put("/api/settings/user", {
            data: {
                summaryPrompt: {
                    selectedPrompt: "cp-contract",
                    customPrompts: [
                        {
                            id: "cp-contract",
                            name: "Contract prompt",
                            prompt: "Summarize in one line. {transcription}",
                            createdAt: "2026-10-16T00:00:00.000Z",
                        },
                    ],
                },
            },
        });
        expect(put.status()).toBe(200);
        const res = await api.post(`/api/recordings/${id}/summary`, { data: {} });
        const body = await res.json();
        expect(body.promptId).toBe("cp-contract");
        expect(body.promptFallback).toBe(false);
    });

    test("a malformed custom prompt is refused in settings", async () => {
        const api = await user("ai-sum-badprompt");
        const res = await api.put("/api/settings/user", {
            data: { summaryPrompt: { selectedPrompt: 5, customPrompts: [] } },
        });
        expect(res.status()).toBe(400);
        const body = await res.json();
        expect(body.code).toBe("INVALID_INPUT");
        expect(body.details).toEqual({ field: "summaryPrompt" });
    });

    test("language is recorded when valid and ignored when not", async () => {
        const api = await user("ai-sum-lang");
        const id = await transcribedRecording(api);
        const ja = await api.post(`/api/recordings/${id}/summary`, {
            data: { language: "ja" },
        });
        expect((await ja.json()).language).toBe("ja");
        const bad = await api.post(`/api/recordings/${id}/summary`, {
            data: { language: "xx" },
        });
        expect((await bad.json()).language).toBe("auto");
    });

    test("an unknown transcript source still summarizes the only transcript", async () => {
        const api = await user("ai-sum-source");
        const id = await transcribedRecording(api);
        const res = await api.post(`/api/recordings/${id}/summary`, {
            data: { source: "no-such-source" },
        });
        expect(res.status()).toBe(200);
        expect((await res.json()).summary).toBe(SUMMARY_TEXT);
    });

    test("concurrent requests for one recording share one result", async () => {
        const api = await user("ai-sum-concurrent");
        const id = await transcribedRecording(api);
        const [a, b] = await Promise.all([
            api.post(`/api/recordings/${id}/summary`, { data: {} }),
            api.post(`/api/recordings/${id}/summary`, { data: {} }),
        ]);
        expect(a.status()).toBe(200);
        expect(b.status()).toBe(200);
        const first = await a.json();
        const second = await b.json();
        expect(second.summary).toBe(first.summary);
        expect(second.promptId).toBe(first.promptId);
        const after = await api.get(`/api/recordings/${id}/summary`);
        expect((await after.json()).generating).toBe(false);
    });

    test("delete removes the summary", async () => {
        const api = await user("ai-sum-delete");
        const id = await transcribedRecording(api);
        expect(
            (await api.post(`/api/recordings/${id}/summary`, { data: {} })).status(),
        ).toBe(200);
        const del = await api.delete(`/api/recordings/${id}/summary`);
        expect(del.status()).toBe(200);
        expect(await del.json()).toEqual({ success: true });
        const after = await api.get(`/api/recordings/${id}/summary`);
        expect(await after.json()).toEqual({ summary: null, generating: false });
    });

    test("another user's recording is not found for summaries", async () => {
        const owner = await user("ai-sum-owner");
        const other = await user("ai-sum-stranger");
        const id = await transcribedRecording(owner);
        const get = await other.get(`/api/recordings/${id}/summary`);
        expect(get.status()).toBe(404);
        expect((await get.json()).code).toBe("RECORDING_NOT_FOUND");
        const post = await other.post(`/api/recordings/${id}/summary`, { data: {} });
        expect(post.status()).toBe(404);
        expect((await post.json()).code).toBe("RECORDING_NOT_FOUND");
    });

    test("an unknown recording is not found for summaries", async () => {
        const api = await user("ai-sum-unknown");
        const res = await api.post(`/api/recordings/${randomUUID()}/summary`, {
            data: {},
        });
        expect(res.status()).toBe(404);
        expect((await res.json()).code).toBe("RECORDING_NOT_FOUND");
    });

    test("automatic summary runs after transcription with the saved preset", async () => {
        const api = await user("ai-sum-auto");
        const put = await api.put("/api/settings/user", {
            data: { autoSummarize: true, autoSummarizePreset: "action-items" },
        });
        expect(put.status()).toBe(200);
        const id = await transcribedRecording(api);
        const body = await waitFor(async () => {
            const res = await api.get(`/api/recordings/${id}/summary`);
            const json = await res.json();
            return json.summary ? json : undefined;
        });
        expect(body.promptId).toBe("action-items");
    });

    test("summary routes need a session", async () => {
        const api = await anonymousContext();
        try {
            const res = await api.get(
                `/api/recordings/${randomUUID()}/summary`,
            );
            expect(res.status()).toBe(401);
            expect((await res.json()).code).toBe("AUTH_SESSION_MISSING");
        } finally {
            await api.dispose();
        }
    });
});
