import { afterEach, describe, expect, it, vi } from "vitest";

// The dev Plaud introspection route (F24), in development: the stored connection and live counts.
const state = vi.hoisted(() => ({
    rows: [] as unknown[],
    listDevices: vi.fn(async () => ({
        data_devices: [{ sn: "A" }, { sn: "B" }],
    })),
    getRecordings: vi.fn(
        async (_start: number, _limit: number, trash: number) =>
            trash ? { data_file_total: 3 } : { data_file_total: 12 },
    ),
}));

vi.mock("@/db", () => ({
    db: {
        select: () => ({
            from: () => ({
                where: () => ({ limit: async () => state.rows }),
            }),
        }),
    },
}));
vi.mock("@/db/schema", () => ({ plaudConnections: {} }));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: vi.fn(async () => ({ user: { id: "user-1" } })),
}));
vi.mock("@/lib/plaud/client-factory", () => ({
    createPlaudClient: vi.fn(async () => ({
        workspaceId: "ws-1",
        usingUserTokenFallback: false,
        listDevices: state.listDevices,
        getRecordings: state.getRecordings,
    })),
}));
vi.mock("@/lib/plaud/proxy", () => ({
    isPlaudProxyConfigured: vi.fn(() => false),
}));
vi.mock("@/lib/plaud/servers", () => ({
    serverKeyFromApiBase: vi.fn(() => "global"),
}));

import { GET } from "@/app/api/dev/plaud/info/route";

const connectionRow = {
    id: "conn-1",
    bearerToken: "encrypted-token",
    apiBase: "https://api.plaud.ai",
    plaudEmail: "user@example.test",
    workspaceId: "ws-1",
    createdAt: new Date("2026-10-01T00:00:00Z"),
    updatedAt: new Date("2026-10-02T00:00:00Z"),
};

describe("dev Plaud info route in development", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        state.rows = [];
        state.listDevices.mockClear();
        state.getRecordings.mockClear();
    });

    it("reports not connected when no connection is stored", async () => {
        vi.stubEnv("NODE_ENV", "development");
        const response = await GET(
            new Request("http://openaudiohub.test/api/dev/plaud/info"),
        );
        await expect(response.json()).resolves.toEqual({ connected: false });
    });

    it("reports the stored connection and the live counts", async () => {
        vi.stubEnv("NODE_ENV", "development");
        state.rows = [connectionRow];

        const response = await GET(
            new Request("http://openaudiohub.test/api/dev/plaud/info"),
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body).toMatchObject({
            connected: true,
            reachable: true,
            error: null,
            connection: { id: "conn-1", server: "global", workspaceId: "ws-1" },
            stats: {
                deviceCount: 2,
                activeRecordingCount: 12,
                trashedRecordingCount: 3,
            },
        });
    });

    it("reports an unreachable Plaud API without failing the request", async () => {
        vi.stubEnv("NODE_ENV", "development");
        state.rows = [connectionRow];
        state.listDevices.mockImplementation(async () => {
            throw new Error("Plaud is down");
        });

        const response = await GET(
            new Request("http://openaudiohub.test/api/dev/plaud/info"),
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body).toMatchObject({
            connected: true,
            reachable: false,
            error: "Plaud is down",
        });
    });
});
