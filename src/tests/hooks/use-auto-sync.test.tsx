// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Automatic Plaud sync (F03): the mount sync, the manual-sync guard, the cross-tab lock,
// the failure path, and the resync on returning to the tab.
const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/lib/api-errors", () => ({
    getApiErrorMessage: vi.fn(async () => "Sync failed"),
}));

import { useAutoSync } from "@/hooks/use-auto-sync";

const LAST_SYNC_KEY = "openaudiohub:last-sync";
const IN_FLIGHT_KEY = "openaudiohub:sync-in-progress";

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}

describe("useAutoSync", () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        localStorage.clear();
        router.refresh.mockReset();
        fetchMock = vi.fn(async () => jsonResponse({ newRecordings: 2 }));
        vi.stubGlobal("fetch", fetchMock);
        Object.defineProperty(document, "visibilityState", {
            configurable: true,
            get: () => "visible",
        });
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("syncs on mount and reports the new recordings", async () => {
        const onSuccess = vi.fn();
        const { result } = renderHook(() => useAutoSync({ onSuccess }));

        await waitFor(() =>
            expect(result.current.lastSyncResult?.success).toBe(true),
        );
        expect(fetchMock).toHaveBeenCalledWith("/api/plaud/sync", {
            method: "POST",
        });
        expect(result.current.lastSyncResult?.newRecordings).toBe(2);
        expect(onSuccess).toHaveBeenCalledWith(2);
        expect(router.refresh).toHaveBeenCalled();
        expect(localStorage.getItem(LAST_SYNC_KEY)).not.toBeNull();
    });

    it("does not sync while disabled", async () => {
        renderHook(() => useAutoSync({ enabled: false }));
        await act(async () => {
            await Promise.resolve();
        });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("refuses a manual sync within five seconds of the last one", async () => {
        const onError = vi.fn();
        const { result } = renderHook(() => useAutoSync({ onError }));
        await waitFor(() => expect(result.current.lastSyncTime).not.toBeNull());

        await act(async () => {
            await result.current.manualSync();
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledWith(
            expect.stringMatching(/^Just synced\. Try again in \d+s\.$/),
        );
    });

    it("waits while another tab has a sync in flight", async () => {
        localStorage.setItem(IN_FLIGHT_KEY, `${Date.now()}:other-tab`);
        renderHook(() => useAutoSync());
        await act(async () => {
            await Promise.resolve();
        });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("reports a failed manual sync and keeps the error status", async () => {
        fetchMock.mockImplementation(async () =>
            jsonResponse({ error: "boom" }, 500),
        );
        const onError = vi.fn();
        const { result } = renderHook(() =>
            useAutoSync({ syncOnMount: false, onError }),
        );

        await act(async () => {
            await result.current.manualSync();
        });
        expect(onError).toHaveBeenCalledWith("Sync failed");
        expect(result.current.lastSyncResult).toMatchObject({
            success: false,
            error: "Sync failed",
        });
    });

    it("resyncs on returning to the tab, then not again straight away", async () => {
        renderHook(() => useAutoSync({ syncOnMount: false, interval: 10_000 }));

        // No sync has happened yet, so the first return to the tab syncs.
        act(() => {
            document.dispatchEvent(new Event("visibilitychange"));
        });
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

        // The sync just finished, so another return to the tab does nothing.
        act(() => {
            document.dispatchEvent(new Event("visibilitychange"));
        });
        await act(async () => {
            await Promise.resolve();
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
