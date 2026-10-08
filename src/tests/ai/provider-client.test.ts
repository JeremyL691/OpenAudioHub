import { beforeEach, describe, expect, it, vi } from "vitest";
import { OPENCODE_GO_SESSION_ID } from "@/lib/brand/legacy";

const openAiCtor = vi.hoisted(() => vi.fn());

vi.mock("openai", () => ({
    OpenAI: openAiCtor,
}));

import {
    createProviderClient,
    resolveChatModel,
} from "@/lib/ai/provider-client";
import {
    isTranscriptionModel,
    supportsTranscription,
} from "@/lib/ai/provider-presets";

describe("createProviderClient", () => {
    beforeEach(() => {
        openAiCtor.mockClear();
    });

    it("sends the OpenCode Go session header on every request", () => {
        createProviderClient(
            {
                provider: "OpenCode Go",
                baseUrl: "https://opencode.ai/zen/go/v1",
            },
            "key",
        );
        expect(openAiCtor).toHaveBeenCalledWith(
            expect.objectContaining({
                baseURL: "https://opencode.ai/zen/go/v1",
                defaultHeaders: {
                    "x-opencode-session": OPENCODE_GO_SESSION_ID,
                },
            }),
        );
    });

    it("adds no default headers for providers without them", () => {
        createProviderClient(
            {
                provider: "SiliconFlow (China)",
                baseUrl: "https://api.siliconflow.cn/v1",
            },
            "key",
            30_000,
        );
        const options = openAiCtor.mock.calls[0]?.[0] as Record<
            string,
            unknown
        >;
        expect(options).not.toHaveProperty("defaultHeaders");
        expect(options.timeout).toBe(30_000);
    });
});

describe("resolveChatModel", () => {
    it("keeps a stored chat model", () => {
        expect(
            resolveChatModel({
                provider: "OpenCode Go",
                baseUrl: null,
                defaultModel: "deepseek-v4.1-flash",
            }),
        ).toBe("deepseek-v4.1-flash");
    });

    it("replaces a stored transcription model with the preset chat model", () => {
        expect(
            resolveChatModel({
                provider: "SiliconFlow (China)",
                baseUrl: "https://api.siliconflow.cn/v1",
                defaultModel: "XingChenAGI/XingChenASR-V3.2-Ultra",
            }),
        ).toBe("Qwen/Qwen2.5-7B-Instruct");
    });

    it("falls back by base URL for a custom Whisper model", () => {
        expect(
            resolveChatModel({
                provider: "Custom",
                baseUrl: "https://api.groq.com/openai/v1",
                defaultModel: "whisper-large-v3",
            }),
        ).toBe("llama-3.1-8b-instant");
        expect(
            resolveChatModel({
                provider: "Custom",
                baseUrl: null,
                defaultModel: null,
            }),
        ).toBe("gpt-4o-mini");
    });
});

describe("provider capabilities", () => {
    it("marks OpenCode Go as chat only and SiliconFlow as transcribing", () => {
        expect(supportsTranscription("OpenCode Go")).toBe(false);
        expect(supportsTranscription("SiliconFlow (China)")).toBe(true);
        expect(supportsTranscription("Unknown provider")).toBe(true);
    });

    it("recognises transcription models by name", () => {
        expect(
            isTranscriptionModel(
                "FunAudioLLM/SenseVoiceSmall",
                "SiliconFlow (China)",
            ),
        ).toBe(true);
        expect(isTranscriptionModel("whisper-1", "OpenAI")).toBe(true);
        expect(isTranscriptionModel("deepseek-v4.1-flash", "OpenCode Go")).toBe(
            false,
        );
    });
});
