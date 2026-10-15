import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    limit: vi.fn(),
    decrypt: vi.fn(),
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

vi.mock("@/lib/env", () => ({
    env: {
        DEFAULT_STORAGE_TYPE: "local",
        DATABASE_URL: "postgres://test@localhost:5432/test",
    },
}));

vi.mock("@/lib/auth-server", () => ({
    requireApiSession: vi.fn(async () => ({ user: { id: "user-1" } })),
}));

vi.mock("@/lib/encryption", () => ({
    decrypt: mocks.decrypt,
}));

import { GET } from "@/app/api/plaud/connection/route";

function b64url(value: unknown): string {
    return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function makeJwt(claims: Record<string, unknown>): string {
    return `${b64url({ alg: "HS256", typ: "UT" })}.${b64url(claims)}.signature-0123456789abcdef`;
}

function connectionRow(overrides: Record<string, unknown> = {}) {
    return {
        apiBase: "https://api.plaud.ai",
        bearerToken: "ciphertext",
        plaudEmail: "user@example.com",
        invalidatedAt: null,
        createdAt: new Date("2026-10-01T00:00:00Z"),
        updatedAt: new Date("2026-10-01T00:00:00Z"),
        ...overrides,
    };
}

async function getBody(): Promise<Record<string, unknown>> {
    const response = await GET(
        new Request("http://127.0.0.1/api/plaud/connection"),
    );
    return (await response.json()) as Record<string, unknown>;
}

describe("GET /api/plaud/connection tokenExpiresAt", () => {
    beforeEach(() => {
        mocks.limit.mockReset();
        mocks.decrypt.mockReset();
    });

    it("reports the stored token's expiry and never the token", async () => {
        const token = makeJwt({ exp: 1_800_000_000 });
        mocks.limit.mockResolvedValue([connectionRow()]);
        mocks.decrypt.mockReturnValue(token);

        const body = await getBody();

        expect(body.connected).toBe(true);
        expect(body.tokenExpiresAt).toBe("2027-01-15T08:00:00.000Z");
        expect(JSON.stringify(body)).not.toContain(token);
    });

    it("reports null when the token has no readable expiry", async () => {
        mocks.limit.mockResolvedValue([connectionRow()]);
        mocks.decrypt.mockReturnValue(makeJwt({ sub: "x" }));

        expect((await getBody()).tokenExpiresAt).toBeNull();
    });

    it("reports null instead of failing when decryption throws", async () => {
        mocks.limit.mockResolvedValue([connectionRow()]);
        mocks.decrypt.mockImplementation(() => {
            throw new Error("bad key");
        });

        const body = await getBody();

        expect(body.connected).toBe(true);
        expect(body.tokenExpiresAt).toBeNull();
    });

    it("omits the expiry when there is no connection", async () => {
        mocks.limit.mockResolvedValue([]);

        expect(await getBody()).toEqual({ connected: false });
    });
});
