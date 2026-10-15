import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@/lib/auth-server", () => ({
    requireApiSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
}));

vi.mock("@/lib/recordings/merge", () => ({
    mergeRecordings: vi.fn().mockResolvedValue("merged-1"),
}));

import { POST } from "@/app/api/recordings/merge/route";
import { mergeRecordings } from "@/lib/recordings/merge";

function post(body: unknown) {
    return POST(
        new Request("http://localhost/api/recordings/merge", {
            method: "POST",
            body: typeof body === "string" ? body : JSON.stringify(body),
        }),
    );
}

describe("POST /api/recordings/merge", () => {
    beforeEach(() => vi.clearAllMocks());

    it("merges the ids in the given order", async () => {
        const res = await post({ ids: ["b", "a"], title: "Talk" });
        expect(res.status).toBe(201);
        expect(await res.json()).toEqual({ id: "merged-1" });
        expect(mergeRecordings).toHaveBeenCalledWith(
            "user-1",
            ["b", "a"],
            "Talk",
        );
    });

    it.each([
        ["fewer than two ids", { ids: ["a"] }],
        ["duplicate ids", { ids: ["a", "a"] }],
        ["malformed ids", { ids: ["a", "../b"] }],
        ["non-array ids", { ids: "a,b" }],
        [
            "too many ids",
            { ids: Array.from({ length: 101 }, (_, i) => `r${i}`) },
        ],
        ["a non-string title", { ids: ["a", "b"], title: 3 }],
        ["a long title", { ids: ["a", "b"], title: "x".repeat(256) }],
        ["invalid JSON", "{"],
    ])("rejects %s", async (_label, body) => {
        const res = await post(body);
        expect(res.status).toBe(400);
        expect(mergeRecordings as Mock).not.toHaveBeenCalled();
    });
});
