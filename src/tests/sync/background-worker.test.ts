import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { dbMock, envMock, syncMock } = vi.hoisted(() => ({
    dbMock: {
        select: vi.fn(),
    },
    envMock: {
        BACKGROUND_SYNC_ENABLED: true,
        BACKGROUND_SYNC_INTERVAL_MS: 5 * 60 * 1000,
    },
    syncMock: {
        syncRecordingsForUser: vi.fn(),
    },
}));

vi.mock("@/db", () => ({ db: dbMock }));
vi.mock("@/db/schema", () => ({
    plaudConnections: {
        userId: "user_id",
        lastSync: "last_sync",
    },
    users: {
        id: "id",
        plan: "plan",
        suspendedAt: "suspended_at",
    },
}));
vi.mock("@/lib/env", () => ({ env: envMock }));
vi.mock("@/lib/sync/sync-recordings", () => syncMock);

import { claimUsersForSync } from "@/lib/sync/worker";

function stubClaimQuery(rows: { userId: string }[]) {
    const where = vi.fn().mockReturnValue({
        orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(rows),
        }),
    });
    dbMock.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({ where }),
        }),
    });
    return where;
}

describe("claimUsersForSync", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("returns user IDs from the query", async () => {
        stubClaimQuery([{ userId: "u1" }, { userId: "u2" }]);
        const result = await claimUsersForSync();
        expect(result).toEqual(["u1", "u2"]);
    });

    it("returns empty array when no eligible users need sync", async () => {
        stubClaimQuery([]);
        const result = await claimUsersForSync();
        expect(result).toEqual([]);
    });

    it("does not filter on plan (every user with a stale connection is eligible)", async () => {
        stubClaimQuery([{ userId: "self-host-user" }]);
        const result = await claimUsersForSync();
        expect(result).toEqual(["self-host-user"]);
    });
});

describe("startBackgroundSyncWorker", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        envMock.BACKGROUND_SYNC_ENABLED = true;
        envMock.BACKGROUND_SYNC_INTERVAL_MS = 5 * 60 * 1000;
        stubClaimQuery([]);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("schedules a tick when BACKGROUND_SYNC_ENABLED is true (default)", async () => {
        vi.resetModules();
        const { startBackgroundSyncWorker } = await import("@/lib/sync/worker");
        startBackgroundSyncWorker();
        expect(vi.getTimerCount()).toBeGreaterThan(0);
    });

    it("does not schedule anything when BACKGROUND_SYNC_ENABLED is false", async () => {
        envMock.BACKGROUND_SYNC_ENABLED = false;
        vi.resetModules();
        const { startBackgroundSyncWorker } = await import("@/lib/sync/worker");
        startBackgroundSyncWorker();
        expect(vi.getTimerCount()).toBe(0);
    });
});
