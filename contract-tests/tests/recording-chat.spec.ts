import { type APIRequestContext, expect, test } from "@playwright/test";
import {
    fakeAiBaseUrl,
    fakeAiControl,
    fakeAiRequests,
    newUserContext,
    uploadRecording,
} from "../helpers/api";

const KEY = "contract-chat-key-3b1f";
const ANSWER = "Contract summary: a short fixed answer.";

const contexts: APIRequestContext[] = [];

async function user(label: string): Promise<APIRequestContext> {
    const api = await newUserContext(label);
    contexts.push(api);
    return api;
}

test.afterEach(async () => {
    await Promise.all(contexts.splice(0).map((api) => api.dispose()));
    // The fake provider is shared by the whole suite, so the answer it was told to give here and
    // its stream settings must not outlive this file.
    await fakeAiControl("/__reset");
});

async function addProvider(api: APIRequestContext, body: Record<string, unknown> = {}): Promise<string> {
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
    const created = (await res.json()) as { provider: { id: string } };
    return created.provider.id;
}

/** A recording with a transcript, which is what a question needs. */
async function transcribedRecording(api: APIRequestContext): Promise<string> {
    const id = await uploadRecording(api);
    const res = await api.post(`/api/recordings/${id}/transcribe`);
    expect(res.status(), "transcribe").toBe(200);
    return id;
}

interface Turn {
    id: string;
    seq: number;
    status: string;
    answer: string;
    question: string;
    citations: {
        sourceId: string;
        quote: string;
        startMs: number | null;
        segmentStart: number | null;
        segmentEnd: number | null;
        line: number | null;
    }[];
    partial: boolean;
    current: boolean;
    effort: { requested: string | null; sent: string | null; known: boolean };
}

/** Reads an answer to the end, through the event stream. */
async function readAnswer(api: APIRequestContext, recordingId: string, turnId: string): Promise<Turn> {
    const res = await api.get(`/api/recordings/${recordingId}/chat/turns/${turnId}/events`, {
        headers: { accept: "text/event-stream" },
        timeout: 30_000,
    });
    expect(res.status()).toBe(200);
    const text = await res.text();
    const events = text
        .split("\n\n")
        .map((frame) => frame.trim())
        .filter(Boolean)
        .map((frame) => {
            const name = /event: (.*)/.exec(frame)?.[1] ?? "message";
            const data = /data: (.*)/.exec(frame)?.[1] ?? "{}";
            return { name, data: JSON.parse(data) as Record<string, unknown> };
        });
    expect(events.length, "at least a snapshot and a done").toBeGreaterThan(1);
    expect(events[0].name, "the first event is the whole turn").toBe("snapshot");
    expect(events.at(-1)?.name, "the last event ends the stream").toBe("done");
    const state = await api.get(`/api/recordings/${recordingId}/chat`);
    const body = (await state.json()) as { turns: Turn[] };
    return body.turns.find((turn) => turn.id === turnId) as Turn;
}

async function waitForTurn(api: APIRequestContext, recordingId: string, turnId: string): Promise<Turn> {
    for (let attempt = 0; attempt < 120; attempt++) {
        const res = await api.get(`/api/recordings/${recordingId}/chat`);
        const body = (await res.json()) as { turns: Turn[] };
        const turn = body.turns.find((row) => row.id === turnId);
        if (turn && ["completed", "failed", "cancelled", "interrupted", "stale"].includes(turn.status)) return turn;
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("the answer did not finish");
}

test.describe("recording chat", () => {
    test("a chat needs a transcript", async () => {
        const api = await user("chat-no-transcript");
        await addProvider(api);
        const id = await uploadRecording(api);
        const res = await api.get(`/api/recordings/${id}/chat`);
        expect(res.status()).toBe(200);
        const body = (await res.json()) as { canAsk: boolean; blockedReason: string; transcript: unknown };
        expect(body.canAsk).toBe(false);
        expect(body.blockedReason).toBe("noTranscript");
        expect(body.transcript).toBeNull();
    });

    test("a question without a provider says so", async () => {
        const api = await user("chat-no-provider");
        const id = await uploadRecording(api);
        const add = await api.post("/api/settings/ai/providers", {
            data: { provider: "Custom", apiKey: KEY, baseUrl: fakeAiBaseUrl, defaultModel: "fake-whisper-1", isDefaultTranscription: true },
        });
        expect(add.status()).toBe(200);
        const res = await api.post(`/api/recordings/${id}/transcribe`);
        expect(res.status()).toBe(200);
        const state = await api.get(`/api/recordings/${id}/chat`);
        const body = (await state.json()) as { canAsk: boolean };
        expect(body.canAsk).toBe(true);
        const removed = await api.get("/api/settings/ai/providers");
        const rows = ((await removed.json()) as { providers: { id: string }[] }).providers;
        for (const row of rows) await api.delete(`/api/settings/ai/providers/${row.id}`);
        const ask = await api.post(`/api/recordings/${id}/chat/turns`, {
            data: { question: "What did we decide?", requestId: "req-1" },
        });
        expect(ask.status()).toBe(400);
        expect(((await ask.json()) as { code: string }).code).toBe("AI_PROVIDER_NOT_CONFIGURED");
    });

    test("an answer streams and is saved with its sources", async () => {
        const api = await user("chat-answer");
        await addProvider(api);
        await fakeAiControl("/__reset");
        await fakeAiControl("/__answer", { content: "We ship on Friday [src_1]." });
        const id = await transcribedRecording(api);
        const ask = await api.post(`/api/recordings/${id}/chat/turns`, {
            data: { question: "When do we ship?", requestId: "req-answer" },
        });
        expect(ask.status(), "a new question is accepted").toBe(202);
        const { turn } = (await ask.json()) as { turn: Turn };
        const finished = await readAnswer(api, id, turn.id);
        expect(finished.status).toBe("completed");
        expect(finished.answer).toContain("Friday");
        // A citation names a passage this turn was given; an invented id would be dropped.
        expect(finished.citations.length).toBe(1);
        const citation = finished.citations[0];
        expect(citation.sourceId).toBe("src_1");
        expect(citation.quote).toContain("Hello from the contract suite");
        // A citation names the transcript row or line it came from, so the app can mark exactly that.
        expect(citation.segmentStart !== null || citation.line !== null, "a citation has a place").toBe(true);
        if (citation.segmentStart !== null) expect(citation.segmentStart).toBe(0);
        if (citation.line !== null) expect(citation.line).toBe(0);
        // A short transcript is read whole and the turn was answered from the transcript in use.
        expect(finished.partial).toBe(false);
        expect(finished.current).toBe(true);
        // The fake provider is shared by the whole file, so only the streamed requests count here.
        const sent = (await fakeAiRequests("/chat/completions")).filter(
            (request) => (request.json as { stream?: boolean } | null)?.stream === true,
        );
        expect(sent.length, "one streaming request").toBeGreaterThan(0);
        // The model reads each citable part on its own line, behind the id it may cite.
        const prompt = JSON.stringify((sent.at(-1)?.json as { messages?: unknown } | null)?.messages ?? []);
        expect(prompt).toMatch(/\[src_1\][^\n]*Hello from the contract suite/);

        const resolved = await api.get(`/api/recordings/${id}/chat/turns/${turn.id}/citations/src_1`);
        expect(resolved.status()).toBe(200);
        const target = (await resolved.json()) as { current: boolean; quote: string; segmentStart: number | null; line: number | null };
        expect(target.current).toBe(true);
        expect(target.quote).toBe(citation.quote);
        expect(target.segmentStart).toBe(citation.segmentStart);
        expect(target.line).toBe(citation.line);
    });

    test("a repeated request answers with the turn it already made", async () => {
        const api = await user("chat-idempotent");
        await addProvider(api);
        const id = await transcribedRecording(api);
        const first = await api.post(`/api/recordings/${id}/chat/turns`, {
            data: { question: "What was decided?", requestId: "req-same" },
        });
        expect(first.status()).toBe(202);
        const { turn } = (await first.json()) as { turn: Turn };
        await waitForTurn(api, id, turn.id);
        const again = await api.post(`/api/recordings/${id}/chat/turns`, {
            data: { question: "What was decided?", requestId: "req-same" },
        });
        expect(again.status(), "a repeat is not accepted as new work").toBe(200);
        const body = (await again.json()) as { turn: Turn };
        expect(body.turn.id).toBe(turn.id);
    });

    test("only one answer runs at a time", async () => {
        const api = await user("chat-busy");
        await addProvider(api);
        await fakeAiControl("/__stream", { delayMs: 60 });
        const id = await transcribedRecording(api);
        const first = await api.post(`/api/recordings/${id}/chat/turns`, {
            data: { question: "First question?", requestId: "req-a" },
        });
        expect(first.status()).toBe(202);
        const second = await api.post(`/api/recordings/${id}/chat/turns`, {
            data: { question: "Second question?", requestId: "req-b" },
        });
        expect(second.status()).toBe(409);
        expect(((await second.json()) as { code: string }).code).toBe("CONFLICT");
        await fakeAiControl("/__stream", { delayMs: 0 });
    });

    test("clearing the chat removes the turns and keeps the preference", async () => {
        const api = await user("chat-clear");
        const providerId = await addProvider(api);
        const id = await transcribedRecording(api);
        const ask = await api.post(`/api/recordings/${id}/chat/turns`, {
            data: { question: "What was decided?", requestId: "req-clear" },
        });
        expect(ask.status()).toBe(202);
        const { turn } = (await ask.json()) as { turn: Turn };
        await waitForTurn(api, id, turn.id);
        const cleared = await api.delete(`/api/recordings/${id}/chat`);
        expect(cleared.status()).toBe(200);
        const state = await api.get(`/api/recordings/${id}/chat`);
        const body = (await state.json()) as { turns: Turn[]; preference: { providerId: string } };
        expect(body.turns).toEqual([]);
        expect(body.preference.providerId).toBe(providerId);
    });

    test("a stopped answer keeps what it had", async () => {
        const api = await user("chat-stop");
        await addProvider(api);
        await fakeAiControl("/__stream", { delayMs: 120 });
        const id = await transcribedRecording(api);
        const ask = await api.post(`/api/recordings/${id}/chat/turns`, {
            data: { question: "Tell me everything.", requestId: "req-stop" },
        });
        expect(ask.status()).toBe(202);
        const { turn } = (await ask.json()) as { turn: Turn };
        await new Promise((resolve) => setTimeout(resolve, 400));
        const stopped = await api.post(`/api/recordings/${id}/chat/turns/${turn.id}/cancel`);
        expect(stopped.status()).toBe(200);
        const finished = await waitForTurn(api, id, turn.id);
        expect(finished.status).toBe("cancelled");
        await fakeAiControl("/__stream", { delayMs: 0 });
    });

    test("an effort a model does not declare is not sent", async () => {
        const api = await user("chat-effort");
        await addProvider(api);
        const id = await transcribedRecording(api);
        const ask = await api.post(`/api/recordings/${id}/chat/turns`, {
            data: { question: "What was decided?", requestId: "req-effort", effort: "max" },
        });
        expect(ask.status()).toBe(202);
        const { turn } = (await ask.json()) as { turn: Turn };
        await waitForTurn(api, id, turn.id);
        // The fake provider publishes no levels, so the choice is kept and nothing is sent.
        const sent = await fakeAiRequests("/chat/completions");
        const body = sent.at(-1)?.json as { reasoning_effort?: string } | undefined;
        expect(body?.reasoning_effort).toBeUndefined();
    });

    test("an unknown effort is refused", async () => {
        const api = await user("chat-bad-effort");
        await addProvider(api);
        const id = await transcribedRecording(api);
        const res = await api.patch(`/api/recordings/${id}/chat`, { data: { effort: "turbo" } });
        expect(res.status()).toBe(400);
        const body = (await res.json()) as { code: string; details?: { field?: string } };
        expect(body.code).toBe("INVALID_INPUT");
        expect(body.details?.field).toBe("effort");
    });

    test("a question with no text is refused", async () => {
        const api = await user("chat-blank");
        await addProvider(api);
        const id = await transcribedRecording(api);
        const res = await api.post(`/api/recordings/${id}/chat/turns`, {
            data: { question: "   ", requestId: "req-blank" },
        });
        expect(res.status()).toBe(400);
    });

    test("a transcript that changed since the question was composed is refused", async () => {
        const api = await user("chat-revision");
        await addProvider(api);
        const id = await transcribedRecording(api);
        const res = await api.post(`/api/recordings/${id}/chat/turns`, {
            data: { question: "What was decided?", requestId: "req-old", revision: "rv_stale" },
        });
        expect(res.status()).toBe(409);
        expect(((await res.json()) as { code: string }).code).toBe("REVISION_CHANGED");
    });

    test("another account cannot read this chat", async () => {
        const owner = await user("chat-owner");
        await addProvider(owner);
        const id = await transcribedRecording(owner);
        const other = await user("chat-other");
        await addProvider(other);
        const res = await other.get(`/api/recordings/${id}/chat`);
        expect(res.status()).toBe(404);
        expect(((await res.json()) as { code: string }).code).toBe("RECORDING_NOT_FOUND");
    });

    test("the chat is never cached", async () => {
        const api = await user("chat-cache");
        await addProvider(api);
        const id = await transcribedRecording(api);
        const res = await api.get(`/api/recordings/${id}/chat`);
        expect(res.headers()["cache-control"]).toBe("private, no-store");
    });
});
