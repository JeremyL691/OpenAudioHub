import { type APIRequestContext, expect } from "@playwright/test";
import { fakeAiBaseUrl } from "./api";

/** Text the fake returns for /v1/audio/transcriptions (verbose path). */
export const FAKE_TRANSCRIPT =
    "Hello from the contract suite. This is a fixed transcript.";
/** Text the fake returns for /v1/chat/completions when the prompt does not ask for JSON. */
export const FAKE_CHAT = "Contract summary: a short fixed answer.";
/** Diarized text the fake's two speaker-labelled segments produce. */
export const FAKE_DIARIZED =
    "[00:00] Speaker 1\nHello from the contract suite.\n\n[00:01] Speaker 2\nThis is a fixed transcript.";

export interface ProviderBody {
    provider: string;
    apiKey?: string;
    baseUrl?: string;
    defaultModel?: string;
    isDefaultTranscription?: boolean;
    isDefaultEnhancement?: boolean;
}

/** Adds a provider for this user through the public API. Returns its id. */
export async function addProvider(
    api: APIRequestContext,
    body: ProviderBody,
): Promise<string> {
    const res = await api.post("/api/settings/ai/providers", {
        data: { apiKey: "contract-local-key", ...body },
    });
    expect(res.ok(), `add provider ${body.provider}`).toBeTruthy();
    const json = (await res.json()) as { provider: { id: string } };
    return json.provider.id;
}

/** The fake OpenAI-compatible provider, as the main account uses it. */
export function fakeProvider(
    overrides: Partial<ProviderBody> = {},
): ProviderBody {
    return {
        provider: "Custom",
        baseUrl: fakeAiBaseUrl,
        defaultModel: "fake-whisper-1",
        isDefaultTranscription: true,
        isDefaultEnhancement: true,
        ...overrides,
    };
}

export interface RecordingDetail {
    recording: { id: string; filename: string; deletedAt: string | null };
    transcription: Record<string, unknown> | null;
}

export async function getDetail(
    api: APIRequestContext,
    id: string,
): Promise<RecordingDetail> {
    const res = await api.get(`/api/recordings/${id}`);
    expect(res.status(), "recording detail").toBe(200);
    return (await res.json()) as RecordingDetail;
}

export async function getPipeline(
    api: APIRequestContext,
    id: string,
): Promise<{
    job: { id: string; status: string } | null;
    timeline: unknown;
    timestampSource: string | null;
    transcription: {
        text: string;
        language?: string;
        source: string;
    } | null;
}> {
    const res = await api.get(`/api/recordings/${id}/audio-pipeline`);
    expect(res.status(), "audio pipeline status").toBe(200);
    return res.json();
}

/**
 * Waits until the pipeline job for a recording reaches a final state. Used
 * only when a transcription was accepted as a background job (HTTP 202).
 */
export async function waitForPipeline(
    api: APIRequestContext,
    id: string,
    timeoutMs = 120_000,
): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const state = await getPipeline(api, id);
        const status = state.job?.status ?? "none";
        if (
            ["completed", "needs_alignment", "failed", "cancelled"].includes(
                status,
            )
        ) {
            return status;
        }
        if (Date.now() > deadline) {
            throw new Error(`pipeline did not finish, last status ${status}`);
        }
        await new Promise((r) => setTimeout(r, 500));
    }
}

/**
 * Runs the manual transcribe call and waits for a background job if the
 * server accepted one. Returns the final HTTP status of the call.
 */
export async function transcribeAndWait(
    api: APIRequestContext,
    id: string,
    data: Record<string, unknown> = {},
): Promise<number> {
    const res = await api.post(`/api/recordings/${id}/transcribe`, { data });
    if (res.status() === 202) {
        await waitForPipeline(api, id);
    }
    return res.status();
}

export interface FakeRequest {
    seq: number;
    method: string;
    path: string;
    fields: Record<string, string>;
    json: { model?: string; messages?: string; response_format?: string } | null;
}

/** Requests the fake AI received for a path suffix (newest last). Shared by all suites. */
export async function fakeRequests(path: string): Promise<FakeRequest[]> {
    const res = await fetch(
        `${fakeAiBaseUrl.replace(/\/v1$/, "")}/__requests?path=${encodeURIComponent(path)}`,
    );
    return (await res.json()) as FakeRequest[];
}
