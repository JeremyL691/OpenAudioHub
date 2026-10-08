import { afterEach, describe, expect, it, vi } from "vitest";

// The dev introspection route is gated on NODE_ENV. The production branch returns before any
// of these modules is used, so they are stubbed here.
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/db/schema", () => ({ plaudConnections: {} }));
vi.mock("@/lib/auth-server", () => ({ requireApiSession: vi.fn() }));
vi.mock("@/lib/plaud/client-factory", () => ({ createPlaudClient: vi.fn() }));
vi.mock("@/lib/plaud/proxy", () => ({
    isPlaudProxyConfigured: vi.fn(() => false),
}));
vi.mock("@/lib/plaud/servers", () => ({ serverKeyFromApiBase: vi.fn() }));

import { GET } from "@/app/api/dev/plaud/info/route";

describe("dev Plaud info route", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("is not found in production builds", async () => {
        vi.stubEnv("NODE_ENV", "production");

        const response = await GET(
            new Request("http://openaudiohub.test/api/dev/plaud/info"),
        );

        expect(response.status).toBe(404);
    });
});
