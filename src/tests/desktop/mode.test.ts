import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let originalNextPhase: string | undefined;
let originalDesktop: string | undefined;

beforeAll(() => {
    originalNextPhase = process.env.NEXT_PHASE;
    originalDesktop = process.env.OAH_DESKTOP;
    process.env.NEXT_PHASE = "phase-production-build";
});

afterAll(() => {
    if (originalNextPhase === undefined) {
        delete process.env.NEXT_PHASE;
    } else {
        process.env.NEXT_PHASE = originalNextPhase;
    }
    if (originalDesktop === undefined) {
        delete process.env.OAH_DESKTOP;
    } else {
        process.env.OAH_DESKTOP = originalDesktop;
    }
});

async function loadIsDesktopMode(value: string | undefined): Promise<boolean> {
    if (value === undefined) {
        delete process.env.OAH_DESKTOP;
    } else {
        process.env.OAH_DESKTOP = value;
    }
    vi.resetModules();
    const { isDesktopMode } = await import("@/lib/desktop/mode");
    return isDesktopMode();
}

describe("isDesktopMode", () => {
    it("is false when OAH_DESKTOP is unset", async () => {
        expect(await loadIsDesktopMode(undefined)).toBe(false);
    });

    it("is false for OAH_DESKTOP=0", async () => {
        expect(await loadIsDesktopMode("0")).toBe(false);
    });

    it("is true when OAH_DESKTOP=1", async () => {
        expect(await loadIsDesktopMode("1")).toBe(true);
    });
});
