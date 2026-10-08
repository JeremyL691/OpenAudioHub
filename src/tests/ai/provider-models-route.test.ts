import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPENCODE_GO_DEFAULT_SESSION_ID } from "@/lib/ai/provider-presets";

vi.mock("@/lib/auth-server", () => ({
    requireApiSession: vi.fn(async () => ({ user: { id: "user-1" } })),
}));

import { POST } from "@/app/api/settings/ai/providers/models/route";

function request(body: Record<string, unknown>) {
    return POST(
        new Request("http://localhost/api/settings/ai/providers/models", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        }),
    );
}

describe("POST /api/settings/ai/providers/models", () => {
    const fetchMock = vi.fn();

    beforeEach(() => {
        fetchMock.mockReset();
        vi.stubGlobal("fetch", fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("lists OpenCode Go chat models with the session header and without the Anthropic-format families", async () => {
        fetchMock.mockResolvedValue(
            Response.json({
                data: [
                    { id: "deepseek-v4.1-flash" },
                    { id: "minimax-m2" },
                    { id: "qwen3-coder" },
                    { id: "glm-5" },
                ],
            }),
        );

        const response = await request({
            provider: "OpenCode Go",
            apiKey: "sk-test",
            kind: "chat",
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            models: [
                { id: "deepseek-v4.1-flash", name: "deepseek-v4.1-flash" },
                { id: "glm-5", name: "glm-5" },
            ],
        });
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe("https://opencode.ai/zen/go/v1/models");
        expect(
            (init.headers as Record<string, string>)["x-opencode-session"],
        ).toBe(OPENCODE_GO_DEFAULT_SESSION_ID);
    });

    it("returns an empty list for a provider without a chat list", async () => {
        const response = await request({
            provider: "LM Studio",
            apiKey: "lm-studio",
            kind: "chat",
        });
        expect(await response.json()).toEqual({ models: [] });
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
