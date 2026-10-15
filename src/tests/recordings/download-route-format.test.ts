import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@/db", () => ({
    db: { select: vi.fn() },
}));

vi.mock("@/lib/auth-server", () => ({
    requireApiSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
}));

vi.mock("@/lib/encryption/fields", () => ({
    decryptText: (value: string) => value,
}));

vi.mock("@/lib/storage/factory", () => ({
    createUserStorageProvider: vi.fn(),
}));

vi.mock("@/lib/recordings/download-audio", async (importOriginal) => {
    const actual =
        await importOriginal<
            typeof import("@/lib/recordings/download-audio")
        >();
    return {
        ...actual,
        openAudioAsMp3: vi.fn(async () => Readable.from([Buffer.from("mp3")])),
    };
});

import { GET } from "@/app/api/recordings/download/route";
import { db } from "@/db";
import { openAudioAsMp3 } from "@/lib/recordings/download-audio";
import { createUserStorageProvider } from "@/lib/storage/factory";

const row = {
    id: "rec-1",
    filename: "Planning Call",
    storagePath: "user-1/rec.ogg",
};

function request(query: string) {
    return new Request(`http://localhost/api/recordings/download?${query}`);
}

describe("GET /api/recordings/download format", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (db.select as Mock).mockReturnValue({
            from: () => ({
                where: async () => [row],
            }),
        });
        (createUserStorageProvider as Mock).mockResolvedValue({
            exists: async () => true,
            downloadStream: async () =>
                Readable.from([Buffer.from("ogg-bytes")]),
        });
    });

    it("rejects an unknown format", async () => {
        const response = await GET(request("ids=rec-1&format=wav"));
        expect(response.status).toBe(400);
    });

    it("sends one original recording as the stored file", async () => {
        const response = await GET(request("ids=rec-1&format=original"));
        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Type")).toMatch(/ogg/);
        expect(response.headers.get("Content-Disposition")).toContain(
            "Planning Call.ogg",
        );
        expect(await response.text()).toBe("ogg-bytes");
        expect(openAudioAsMp3).not.toHaveBeenCalled();
    });

    it("defaults to a zip of MP3s", async () => {
        const response = await GET(request("ids=rec-1"));
        expect(response.headers.get("Content-Type")).toBe("application/zip");
        await response.arrayBuffer();
        expect(openAudioAsMp3).toHaveBeenCalledTimes(1);
    });
});
