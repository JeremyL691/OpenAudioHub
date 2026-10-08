/**
 * Pins the per-user rate limit on POST /api/plaud/sync.
 *
 * The Postgres-backed bucket is unit-tested in v1-rate-limit.test.ts; this
 * file pins the Plaud-sync-specific wiring: env-configured limit, 429
 * envelope shape, RATE_LIMITED code, and the rate-limit headers Retry-After
 * + X-RateLimit-*.
 */

import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

const mockEnv = vi.hoisted(() => ({
    BETTER_AUTH_SECRET: "better-auth-secret-with-32-chars",
    API_TOKEN_HASH_SECRET: undefined as string | undefined,
    PLAUD_SYNC_RATE_LIMIT_PER_MINUTE: 10,
}));

vi.mock("@/lib/env", () => ({
    env: mockEnv,
}));

vi.mock("@/db", () => ({
    db: {
        insert: vi.fn(),
    },
}));

import { db } from "@/db";
import { ErrorCode } from "@/lib/errors";
import { enforcePlaudSyncRateLimit } from "@/lib/plaud/sync-rate-limit";

function mockBucketCount(count: number, resetAt: Date) {
    (db.insert as unknown as Mock).mockReturnValue({
        values: vi.fn().mockReturnValue({
            onConflictDoUpdate: vi.fn().mockReturnValue({
                returning: vi.fn().mockResolvedValue([{ count, resetAt }]),
            }),
        }),
    });
}

describe("enforcePlaudSyncRateLimit", () => {
    beforeEach(() => {
        mockEnv.PLAUD_SYNC_RATE_LIMIT_PER_MINUTE = 10;
        vi.clearAllMocks();
    });

    it("returns null when the bucket is under the limit", async () => {
        const resetAt = new Date(Date.now() + 60_000);
        mockBucketCount(3, resetAt);

        const result = await enforcePlaudSyncRateLimit("user-1");
        expect(result).toBeNull();
    });

    it("returns a 429 envelope with rate-limit headers when exhausted", async () => {
        const resetAt = new Date(Date.now() + 45_000);
        mockBucketCount(11, resetAt);

        const response = await enforcePlaudSyncRateLimit("user-1");
        expect(response).not.toBeNull();
        if (!response) return;

        expect(response.status).toBe(429);
        expect(response.headers.get("X-RateLimit-Limit")).toBe("10");
        expect(response.headers.get("X-RateLimit-Remaining")).toBe("0");
        expect(response.headers.get("X-RateLimit-Reset")).toBe(
            Math.ceil(resetAt.getTime() / 1000).toString(),
        );
        expect(response.headers.get("Retry-After")).toBeTruthy();

        const body = (await response.json()) as {
            code: ErrorCode;
            details: { limit: number; remaining: number };
        };
        expect(body.code).toBe(ErrorCode.RATE_LIMITED);
        expect(body.details.limit).toBe(10);
        expect(body.details.remaining).toBe(0);
    });

    it("honors the env-configured per-minute limit", async () => {
        mockEnv.PLAUD_SYNC_RATE_LIMIT_PER_MINUTE = 3;
        const resetAt = new Date(Date.now() + 30_000);
        mockBucketCount(4, resetAt);

        const response = await enforcePlaudSyncRateLimit("user-1");
        expect(response).not.toBeNull();
        if (!response) return;
        expect(response.headers.get("X-RateLimit-Limit")).toBe("3");
    });
});
