/**
 * `generateSummaryForRecording` must never route to an ElevenLabs
 * credential -- ElevenLabs Scribe is transcription-only and has no
 * `chat.completions` endpoint. These tests pin the enhancement-provider
 * selection: skip ElevenLabs and fall through to another provider, and
 * fall back to the existing "no provider" `AppError` when ElevenLabs is
 * the only configured credential.
 */

import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@/db", () => ({
    db: {
        select: vi.fn(),
    },
}));

vi.mock("@/lib/encryption", () => ({
    decrypt: vi.fn().mockReturnValue("fake-api-key"),
}));

vi.mock("@/lib/encryption/fields", () => ({
    decryptJsonField: vi.fn().mockReturnValue(null),
    decryptText: vi.fn((value: string) => value),
}));

vi.mock("@/lib/transcription/persist", () => ({
    upsertEnhancement: vi.fn().mockResolvedValue({ committed: true }),
}));

const { chatCompletionsCreate } = vi.hoisted(() => ({
    chatCompletionsCreate: vi.fn(),
}));

vi.mock("openai", () => {
    // biome-ignore lint/complexity/useArrowFunction: mock must be constructable
    const MockOpenAI = vi.fn(function () {
        return {
            chat: { completions: { create: chatCompletionsCreate } },
        };
    });
    return { OpenAI: MockOpenAI };
});

import { db } from "@/db";
import { ErrorCode } from "@/lib/errors";
import { generateSummaryForRecording } from "@/lib/summary/generate-summary";
import { upsertEnhancement } from "@/lib/transcription/persist";

const userId = "user-1";
const recordingId = "rec-1";

function mockLookups(
    credentialRows: Record<string, unknown>[],
    transcriptRows: Record<string, unknown>[] = [
        { text: "raw transcript", source: "openaudiohub" },
    ],
) {
    (db.select as Mock)
        // recording
        .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                    limit: vi
                        .fn()
                        .mockResolvedValue([{ id: recordingId, userId }]),
                }),
            }),
        })
        // transcription
        .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
                where: vi.fn().mockResolvedValue(transcriptRows),
            }),
        })
        // user settings
        .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue([]),
                }),
            }),
        })
        // credentials
        .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                    orderBy: vi.fn().mockResolvedValue(credentialRows),
                }),
            }),
        });
}

beforeEach(() => {
    vi.clearAllMocks();
    chatCompletionsCreate.mockResolvedValue({
        choices: [
            {
                message: {
                    content: JSON.stringify({
                        summary: "A summary",
                        keyPoints: [],
                        actionItems: [],
                    }),
                },
            },
        ],
    });
});

describe("generateSummaryForRecording -- enhancement provider exclusion", () => {
    it("skips an ElevenLabs credential and falls through to another provider", async () => {
        mockLookups([
            {
                id: "creds-el",
                provider: "ElevenLabs",
                apiKey: "enc-1",
                baseUrl: null,
                defaultModel: "scribe_v2",
                isDefaultEnhancement: true,
                createdAt: new Date("2026-01-01"),
            },
            {
                id: "creds-oai",
                provider: "OpenAI",
                apiKey: "enc-2",
                baseUrl: null,
                defaultModel: "gpt-4o-mini",
                isDefaultEnhancement: false,
                createdAt: new Date("2026-01-02"),
            },
        ]);

        const result = await generateSummaryForRecording(userId, recordingId);

        expect(result.provider).toBe("OpenAI");
        expect(result.summary).toBe("A summary");
        expect(chatCompletionsCreate).toHaveBeenCalledOnce();
        const payload = chatCompletionsCreate.mock.calls[0][0] as {
            messages: { role: string; content: string }[];
        };
        expect(payload.messages[0]?.role).toBe("system");
        expect(payload.messages[0]?.content).toMatch(/untrusted/i);
        expect(payload.messages[0]?.content).not.toContain("raw transcript");
        expect(payload.messages[1]?.role).toBe("user");
        expect(payload.messages[1]?.content).toContain("raw transcript");
    });

    it("throws AI_PROVIDER_NOT_CONFIGURED when ElevenLabs is the only credential", async () => {
        mockLookups([
            {
                id: "creds-el",
                provider: "ElevenLabs",
                apiKey: "enc-1",
                baseUrl: null,
                defaultModel: "scribe_v2",
                isDefaultEnhancement: true,
                createdAt: new Date("2026-01-01"),
            },
        ]);

        await expect(
            generateSummaryForRecording(userId, recordingId),
        ).rejects.toMatchObject({
            code: ErrorCode.AI_PROVIDER_NOT_CONFIGURED,
        });
        expect(chatCompletionsCreate).not.toHaveBeenCalled();
    });
});

describe("generateSummaryForRecording -- transcript source", () => {
    const openAiCredentials = [
        {
            id: "creds-oai",
            provider: "OpenAI",
            apiKey: "enc-1",
            baseUrl: null,
            defaultModel: "gpt-4o-mini",
            isDefaultEnhancement: true,
            createdAt: new Date("2026-01-01"),
        },
    ];
    const transcripts = [
        { text: "own text", source: "openaudiohub" },
        { text: "plaud text", source: "plaud" },
    ];

    it("summarizes the requested source when it is stored", async () => {
        mockLookups(openAiCredentials, transcripts);
        await generateSummaryForRecording(userId, recordingId, {
            source: "plaud",
        });
        const payload = chatCompletionsCreate.mock.calls[0][0] as {
            messages: { content: string }[];
        };
        expect(payload.messages[1]?.content).toContain("plaud text");
        expect(payload.messages[1]?.content).not.toContain("own text");
    });

    it("falls back to the own transcript when the requested source is not stored", async () => {
        mockLookups(openAiCredentials, transcripts);
        await generateSummaryForRecording(userId, recordingId, {
            source: "mixed",
        });
        const payload = chatCompletionsCreate.mock.calls[0][0] as {
            messages: { content: string }[];
        };
        expect(payload.messages[1]?.content).toContain("own text");
    });
});

describe("generateSummaryForRecording -- model output", () => {
    const openAiCredentials = [
        {
            id: "creds-oai",
            provider: "OpenAI",
            apiKey: "enc-1",
            baseUrl: null,
            defaultModel: "gpt-4o-mini",
            isDefaultEnhancement: true,
            createdAt: new Date("2026-01-01"),
        },
    ];

    it("asks for a token budget that leaves room for reasoning", async () => {
        mockLookups(openAiCredentials);
        await generateSummaryForRecording(userId, recordingId);
        const payload = chatCompletionsCreate.mock.calls[0][0] as {
            max_tokens?: number;
        };
        expect(payload.max_tokens).toBe(16384);
    });

    it("rejects an empty reply cut off at the limit without saving", async () => {
        chatCompletionsCreate.mockResolvedValueOnce({
            choices: [{ finish_reason: "length", message: { content: "" } }],
        });
        mockLookups(openAiCredentials);
        await expect(
            generateSummaryForRecording(userId, recordingId),
        ).rejects.toMatchObject({
            code: ErrorCode.UPSTREAM_BAD_RESPONSE,
        });
        expect(upsertEnhancement).not.toHaveBeenCalled();
    });

    it("rejects a whitespace-only reply without saving", async () => {
        chatCompletionsCreate.mockResolvedValueOnce({
            choices: [{ finish_reason: "stop", message: { content: " \n " } }],
        });
        mockLookups(openAiCredentials);
        await expect(
            generateSummaryForRecording(userId, recordingId),
        ).rejects.toMatchObject({
            code: ErrorCode.UPSTREAM_BAD_RESPONSE,
        });
        expect(upsertEnhancement).not.toHaveBeenCalled();
    });

    it("saves a reply cut off at the limit when it has text", async () => {
        chatCompletionsCreate.mockResolvedValueOnce({
            choices: [
                {
                    finish_reason: "length",
                    message: { content: "Partial summary" },
                },
            ],
        });
        mockLookups(openAiCredentials);
        const result = await generateSummaryForRecording(userId, recordingId);
        expect(result.summary).toBe("Partial summary");
        expect(upsertEnhancement).toHaveBeenCalledOnce();
    });
});
