import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@/db", () => ({
    db: {
        update: vi.fn(),
    },
}));

vi.mock("@/lib/auth-server", () => ({
    requireApiSession: vi.fn().mockResolvedValue({
        user: { id: "user-1" },
    }),
}));

vi.mock("drizzle-orm", async (importOriginal) => {
    const actual = await importOriginal<typeof import("drizzle-orm")>();
    return {
        ...actual,
        eq: vi.fn(actual.eq),
    };
});

import { eq } from "drizzle-orm";
import { PUT as starRecording } from "@/app/api/recordings/[id]/star/route";
import { db } from "@/db";
import { requireApiSession } from "@/lib/auth-server";

function updateReturning(rows: unknown[]) {
    const returning = vi.fn().mockResolvedValue(rows);
    const where = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where });
    (db.update as unknown as Mock).mockReturnValueOnce({ set });
    return { set, where };
}

function putStar(id: string, body: unknown) {
    return starRecording(
        new Request(`http://localhost/api/recordings/${id}/star`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: typeof body === "string" ? body : JSON.stringify(body),
        }),
        { params: Promise.resolve({ id }) },
    );
}

describe("PUT /api/recordings/[id]/star", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (requireApiSession as unknown as Mock).mockResolvedValue({
            user: { id: "user-1" },
        });
    });

    it("returns 400 when starred is missing or not a boolean", async () => {
        const response = await putStar("rec-1", { starred: "yes" });

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
            code: "INVALID_INPUT",
            details: { field: "starred" },
        });
        expect(db.update).not.toHaveBeenCalled();
    });

    it("returns 400 when the body is not a JSON object", async () => {
        const response = await putStar("rec-1", "[true]");

        expect(response.status).toBe(400);
        expect(db.update).not.toHaveBeenCalled();
    });

    it("returns 404 when no owned, non-deleted recording matched", async () => {
        updateReturning([]);

        const response = await putStar("rec-missing", { starred: true });

        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toMatchObject({
            code: "RECORDING_NOT_FOUND",
        });
    });

    it("stars a recording and returns starred: true", async () => {
        const { set } = updateReturning([{ id: "rec-1" }]);

        const response = await putStar("rec-1", { starred: true });

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
            id: "rec-1",
            starred: true,
        });
        const values = set.mock.calls[0][0] as {
            starredAt: unknown;
            updatedAt: Date;
        };
        expect(values.starredAt).toBeDefined();
        expect(values.starredAt).not.toBeNull();
        expect(values.updatedAt).toBeInstanceOf(Date);
    });

    it("unstars a recording by clearing starredAt", async () => {
        const { set } = updateReturning([{ id: "rec-1" }]);

        const response = await putStar("rec-1", { starred: false });

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
            id: "rec-1",
            starred: false,
        });
        expect(set.mock.calls[0][0]).toMatchObject({ starredAt: null });
    });

    it("scopes the update to the session user and to non-deleted rows", async () => {
        updateReturning([{ id: "rec-1" }]);

        await putStar("rec-1", { starred: true });

        const eqCalls = (eq as unknown as Mock).mock.calls.map(
            ([, value]) => value,
        );
        expect(eqCalls).toContain("rec-1");
        expect(eqCalls).toContain("user-1");
    });
});
