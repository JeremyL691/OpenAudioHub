// @vitest-environment jsdom
import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncRingLabel, syncRingState } from "@/components/app-shell/sync-ring";
import { UserMenu } from "@/components/dashboard/user-menu";
import { TooltipProvider } from "@/components/ui/tooltip";

const syncMock = vi.hoisted(() => ({
    current: {} as Record<string, unknown>,
    manualSync: vi.fn(),
}));

vi.mock("@/components/app-shell/providers", () => ({
    useSyncStatus: () => syncMock.current,
}));
vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/auth-client", () => ({ signOut: vi.fn() }));
vi.mock("@/hooks/use-theme", () => ({
    useTheme: () => ({ theme: "system", setTheme: vi.fn() }),
}));

// Radix measures the tooltip anchor with ResizeObserver, which jsdom lacks.
beforeEach(() => {
    vi.stubGlobal(
        "ResizeObserver",
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

const base = {
    isAutoSyncing: false,
    lastSyncTime: null,
    nextSyncTime: null,
    lastSyncResult: null,
};

describe("syncRingState", () => {
    it("is idle before any sync result is known", () => {
        expect(syncRingState(base)).toBe("idle");
    });

    it("is ok after a successful sync", () => {
        expect(
            syncRingState({
                ...base,
                lastSyncTime: new Date(),
                lastSyncResult: { success: true },
            }),
        ).toBe("ok");
    });

    it("is failed after a failed sync", () => {
        expect(
            syncRingState({
                ...base,
                lastSyncResult: { success: false, error: "boom" },
            }),
        ).toBe("failed");
    });

    it("is failed when Plaud needs reconnecting, even on a successful sync", () => {
        expect(
            syncRingState({
                ...base,
                lastSyncResult: { success: true, needsReconnect: true },
            }),
        ).toBe("failed");
    });

    it("is syncing while a sync is in flight, whatever the last result", () => {
        expect(
            syncRingState({
                ...base,
                isAutoSyncing: true,
                lastSyncResult: { success: false, error: "boom" },
            }),
        ).toBe("syncing");
    });
});

describe("syncRingLabel", () => {
    it("describes each state", () => {
        const now = Date.now();
        expect(syncRingLabel(base)).toBe("Not synced yet");
        expect(
            syncRingLabel({
                ...base,
                isAutoSyncing: true,
            }),
        ).toBe("Syncing…");
        expect(
            syncRingLabel({
                ...base,
                lastSyncResult: { success: false, error: "Network down" },
            }),
        ).toBe("Sync failed: Network down");
        expect(
            syncRingLabel({
                ...base,
                lastSyncResult: { success: true, needsReconnect: true },
            }),
        ).toBe("Plaud needs reconnecting");
        expect(
            syncRingLabel({
                ...base,
                lastSyncTime: new Date(now - 2 * 60_000),
                nextSyncTime: new Date(now + 3 * 60_000),
                lastSyncResult: { success: true },
            }),
        ).toBe("Synced 2m ago · Next sync in 3m");
    });
});

function renderMenu(overrides: Record<string, unknown>) {
    syncMock.current = {
        ...base,
        manualSync: syncMock.manualSync,
        ...overrides,
    };
    return render(
        <TooltipProvider>
            <UserMenu
                initialTheme="system"
                userEmail="owner@example.test"
                onOpenSettings={vi.fn()}
                onOpenShortcuts={vi.fn()}
            />
        </TooltipProvider>,
    );
}

describe("avatar sync ring", () => {
    it("exposes the sync state and extends the aria-label", () => {
        renderMenu({
            lastSyncTime: new Date(),
            lastSyncResult: { success: false, error: "boom" },
        });

        const trigger = screen.getByTestId("user-menu");
        expect(trigger.getAttribute("data-sync-state")).toBe("failed");
        expect(trigger.getAttribute("aria-label")).toBe(
            "Account menu, sync failed",
        );
    });

    it("shows the sync status in a tooltip on hover", async () => {
        renderMenu({
            lastSyncTime: new Date(Date.now() - 2 * 60_000),
            lastSyncResult: { success: true },
        });

        fireEvent.focus(screen.getByTestId("user-menu"));
        await waitFor(() =>
            expect(screen.getAllByText("Synced 2m ago").length).toBeGreaterThan(
                0,
            ),
        );
    });

    it("runs manualSync from the Sync now item", () => {
        syncMock.manualSync.mockClear();
        renderMenu({ lastSyncResult: { success: true } });

        fireEvent.keyDown(screen.getByTestId("user-menu"), { key: "Enter" });
        fireEvent.click(screen.getByText("Sync now"));

        expect(syncMock.manualSync).toHaveBeenCalledTimes(1);
    });

    it("disables Sync now while a sync is running", () => {
        renderMenu({ isAutoSyncing: true });

        fireEvent.keyDown(screen.getByTestId("user-menu"), { key: "Enter" });
        const item = screen.getByText("Sync now").closest("[role=menuitem]");
        expect(item?.getAttribute("data-disabled")).not.toBeNull();
    });
});
