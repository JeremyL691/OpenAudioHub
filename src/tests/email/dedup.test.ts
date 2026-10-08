import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbMock } = vi.hoisted(() => ({
    dbMock: { insert: vi.fn(), delete: vi.fn() },
}));

vi.mock("@/db", () => ({ db: dbMock }));
vi.mock("@/db/schema", () => ({
    emailLog: { id: "id", userId: "user_id", kind: "kind" },
}));

import { claimEmailSend, releaseEmailSend } from "@/db/queries/email-log";

function chainInsertReturning(returning: unknown[]) {
    const chain = {
        values: vi.fn().mockReturnValue({
            onConflictDoNothing: vi.fn().mockReturnValue({
                returning: vi.fn().mockResolvedValue(returning),
            }),
        }),
    };
    dbMock.insert.mockReturnValueOnce(chain);
}

describe("claimEmailSend", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("returns true when the row was inserted (first send wins)", async () => {
        chainInsertReturning([{ id: "el_1" }]);
        const ok = await claimEmailSend({
            userId: "u1",
            kind: "export_ready:job-1",
        });
        expect(ok).toBe(true);
    });

    it("returns false when the row already exists (duplicate send skipped)", async () => {
        chainInsertReturning([]);
        const ok = await claimEmailSend({
            userId: "u1",
            kind: "export_ready:job-1",
        });
        expect(ok).toBe(false);
    });

    it("scopes dedup per kind for the same user (different kinds don't collide)", async () => {
        chainInsertReturning([{ id: "a" }]);
        chainInsertReturning([{ id: "b" }]);
        const a = await claimEmailSend({
            userId: "u1",
            kind: "export_ready:job-1",
        });
        const b = await claimEmailSend({
            userId: "u1",
            kind: "export_ready:job-2",
        });
        expect(a).toBe(true);
        expect(b).toBe(true);
    });
});

describe("releaseEmailSend", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("deletes the claim row so a future retry can claim again", async () => {
        const where = vi.fn().mockResolvedValue(undefined);
        dbMock.delete.mockReturnValue({ where });
        await releaseEmailSend({ userId: "u1", kind: "export_ready:job-1" });
        expect(dbMock.delete).toHaveBeenCalled();
        expect(where).toHaveBeenCalled();
    });
});
