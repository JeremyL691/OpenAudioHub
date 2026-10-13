import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    limit: vi.fn(),
    chatCreate: vi.fn(),
    whisperCreate: vi.fn(),
    runFfmpeg: vi.fn(),
}));

vi.mock("@/db", () => ({
    db: {
        select: vi.fn(() => ({
            from: () => ({
                where: () => ({ limit: mocks.limit }),
            }),
        })),
    },
}));

vi.mock("@/lib/auth-server", () => ({
    requireApiSession: vi.fn(async () => ({ user: { id: "user-1" } })),
}));

vi.mock("@/lib/encryption", () => ({
    decrypt: vi.fn(() => "stored-key"),
}));

vi.mock("@/lib/env", () => ({
    env: { WHISPER_REQUEST_TIMEOUT_MS: 60_000 },
}));

vi.mock("@/lib/transcription/ffmpeg", () => ({
    runFfmpeg: mocks.runFfmpeg,
}));

vi.mock("openai", () => ({
    OpenAI: class {
        chat = { completions: { create: mocks.chatCreate } };
        audio = { transcriptions: { create: mocks.whisperCreate } };
    },
}));

import { POST } from "@/app/api/settings/ai/providers/test/route";

function request(body: Record<string, unknown>) {
    return POST(
        new Request("http://localhost/api/settings/ai/providers/test", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        }),
    );
}

describe("POST /api/settings/ai/providers/test", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.chatCreate.mockResolvedValue({ choices: [] });
        mocks.whisperCreate.mockResolvedValue({ text: "" });
        mocks.runFfmpeg.mockResolvedValue(Buffer.from("mp3"));
    });

    it("returns 400 when neither an api key nor a stored id is given", async () => {
        const response = await request({ provider: "OpenAI", model: "gpt-4o" });
        expect(response.status).toBe(400);
        expect(mocks.chatCreate).not.toHaveBeenCalled();
    });

    it("runs a chat completion for a chat model", async () => {
        const response = await request({
            provider: "Groq",
            model: "llama-3.1-8b-instant",
            apiKey: "sk-test",
        });
        const body = await response.json();

        expect(body).toEqual({
            ok: true,
            latencyMs: expect.any(Number),
            kind: "chat",
        });
        expect(mocks.chatCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                model: "llama-3.1-8b-instant",
                max_tokens: 16,
                temperature: 0,
            }),
        );
        expect(mocks.whisperCreate).not.toHaveBeenCalled();
    });

    it("runs a whisper transcription for a transcription model", async () => {
        const response = await request({
            provider: "OpenAI",
            model: "whisper-1",
            apiKey: "sk-test",
        });
        const body = await response.json();

        expect(body).toEqual({
            ok: true,
            latencyMs: expect.any(Number),
            kind: "transcription",
        });
        expect(mocks.runFfmpeg).toHaveBeenCalledOnce();
        expect(mocks.whisperCreate).toHaveBeenCalledWith(
            expect.objectContaining({ model: "whisper-1" }),
        );
        expect(mocks.chatCreate).not.toHaveBeenCalled();
    });

    it("returns ok:false with the api key redacted when the upstream throws", async () => {
        mocks.chatCreate.mockRejectedValue(
            new Error("Incorrect API key provided: sk-secret-123"),
        );

        const response = await request({
            provider: "Groq",
            model: "llama-3.1-8b-instant",
            apiKey: "sk-secret-123",
        });
        const text = await response.text();
        const body = JSON.parse(text);

        expect(response.status).toBe(200);
        expect(body).toEqual({
            ok: false,
            kind: "chat",
            error: "Incorrect API key provided: ***",
        });
        expect(text).not.toContain("sk-secret-123");
    });
});
