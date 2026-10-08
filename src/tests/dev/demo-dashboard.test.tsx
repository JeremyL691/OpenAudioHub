import { afterEach, describe, expect, it, vi } from "vitest";

// The dev-only screenshot route (F24): not found in production, behind a session in development.
vi.mock("@/components/dashboard/workstation", () => ({
    Workstation: () => null,
}));
vi.mock("@/lib/auth-server", () => ({
    requireAuth: vi.fn(async () => ({ user: { id: "user-1" } })),
}));
vi.mock("@/lib/demo/fixtures", () => ({
    buildDemoRecordings: () => [],
    buildDemoTranscriptions: () => ({}),
    DEMO_INITIAL_SETTINGS: {},
}));

import DemoDashboardPage from "@/app/(app)/dev/demo-dashboard/page";
import { requireAuth } from "@/lib/auth-server";

describe("demo dashboard route", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.mocked(requireAuth).mockClear();
    });

    it("is not found in production builds", async () => {
        vi.stubEnv("NODE_ENV", "production");
        await expect(DemoDashboardPage()).rejects.toThrow();
        expect(requireAuth).not.toHaveBeenCalled();
    });

    it("requires a signed-in user in development", async () => {
        vi.stubEnv("NODE_ENV", "development");
        await DemoDashboardPage();
        expect(requireAuth).toHaveBeenCalledTimes(1);
    });
});
