import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    type AppResponse,
    type FetchApp,
    type PlaudConnectionStatus,
    type PlaudTokenRefresherOptions,
    shouldRefresh,
    startPlaudTokenRefresher,
} from "../src/main/plaud-refresh.js";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-10-14T12:00:00Z");
const TOKEN =
    "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjk5OTk5OTk5OTl9.TOKEN-SECRET-VALUE";
const NEW_TOKEN =
    "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjk5OTk5OTk5OTl9.NEW-SECRET-VALUE";

function conn(
    overrides: Partial<PlaudConnectionStatus> = {},
): PlaudConnectionStatus {
    return {
        connected: true,
        needsReconnect: false,
        tokenExpiresAt: new Date(NOW + 20 * HOUR).toISOString(),
        server: "global",
        ...overrides,
    };
}

describe("shouldRefresh", () => {
    it("does nothing without a connection", () => {
        expect(shouldRefresh({ connected: false }, NOW, 6 * HOUR)).toBe(false);
    });

    it("refreshes once the expiry is within the window", () => {
        const inWindow = conn({
            tokenExpiresAt: new Date(NOW + 5 * HOUR).toISOString(),
        });
        expect(shouldRefresh(inWindow, NOW, 6 * HOUR)).toBe(true);
        const exactly = conn({
            tokenExpiresAt: new Date(NOW + 6 * HOUR).toISOString(),
        });
        expect(shouldRefresh(exactly, NOW, 6 * HOUR)).toBe(true);
    });

    it("leaves a fresh token alone", () => {
        expect(shouldRefresh(conn(), NOW, 6 * HOUR)).toBe(false);
    });

    it("refreshes an expired token", () => {
        const expired = conn({
            tokenExpiresAt: new Date(NOW - HOUR).toISOString(),
        });
        expect(shouldRefresh(expired, NOW, 6 * HOUR)).toBe(true);
    });

    it("refreshes after Plaud rejected the token, whatever the expiry", () => {
        expect(
            shouldRefresh(conn({ needsReconnect: true }), NOW, 6 * HOUR),
        ).toBe(true);
        expect(
            shouldRefresh(
                conn({ needsReconnect: true, tokenExpiresAt: null }),
                NOW,
                6 * HOUR,
            ),
        ).toBe(true);
    });

    it("does not refresh an unknown expiry unless Plaud rejected the token", () => {
        expect(
            shouldRefresh(conn({ tokenExpiresAt: null }), NOW, 6 * HOUR),
        ).toBe(false);
        expect(
            shouldRefresh(
                conn({ tokenExpiresAt: "not a date" }),
                NOW,
                6 * HOUR,
            ),
        ).toBe(false);
    });
});

function jsonResponse(status: number, body: unknown): AppResponse {
    return { status, json: async () => body };
}

interface Harness {
    fetchApp: ReturnType<typeof vi.fn<FetchApp>>;
    refresh: ReturnType<typeof vi.fn<PlaudTokenRefresherOptions["refresh"]>>;
    log: ReturnType<typeof vi.fn<(message: string) => void>>;
    logged: () => string;
}

function harness(
    connection: PlaudConnectionStatus,
    refreshResult: unknown = {
        accessToken: NEW_TOKEN,
        apiBase: "https://api.plaud.ai",
        region: "global",
        capturedAt: NOW,
    },
): Harness {
    const fetchApp = vi.fn<FetchApp>(async (path) => {
        if (path === "/api/plaud/connection")
            return jsonResponse(200, connection);
        if (path === "/api/plaud/auth/connect-token")
            return jsonResponse(200, { success: true });
        throw new Error(`unexpected ${path}`);
    });
    const refresh = vi.fn<PlaudTokenRefresherOptions["refresh"]>(
        async () =>
            refreshResult as Awaited<
                ReturnType<PlaudTokenRefresherOptions["refresh"]>
            >,
    );
    const log = vi.fn<(message: string) => void>();
    return {
        fetchApp,
        refresh,
        log,
        logged: () => log.mock.calls.map(([message]) => message).join("\n"),
    };
}

describe("startPlaudTokenRefresher", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("runs once after the first delay, then on each interval", async () => {
        const h = harness(conn());
        const stop = startPlaudTokenRefresher({
            fetchApp: h.fetchApp,
            refresh: h.refresh,
            log: h.log,
            firstRunDelayMs: 60_000,
            intervalMs: 30 * 60_000,
        });

        await vi.advanceTimersByTimeAsync(59_000);
        expect(h.fetchApp).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(h.fetchApp).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(30 * 60_000);
        expect(h.fetchApp).toHaveBeenCalledTimes(2);
        stop();
    });

    it("does not call refresh while the token is fresh", async () => {
        const h = harness(conn());
        const stop = startPlaudTokenRefresher({
            fetchApp: h.fetchApp,
            refresh: h.refresh,
            log: h.log,
        });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(h.refresh).not.toHaveBeenCalled();
        expect(h.fetchApp).toHaveBeenCalledTimes(1);
        stop();
    });

    it("refreshes a token near expiry and posts it to connect-token", async () => {
        const h = harness(
            conn({ tokenExpiresAt: new Date(NOW + HOUR).toISOString() }),
        );
        const stop = startPlaudTokenRefresher({
            fetchApp: h.fetchApp,
            refresh: h.refresh,
            log: h.log,
        });
        await vi.advanceTimersByTimeAsync(60_000);

        expect(h.refresh).toHaveBeenCalledWith(
            NOW + HOUR,
            expect.objectContaining({ connected: true }),
        );
        const post = h.fetchApp.mock.calls.find(
            ([path]) => path === "/api/plaud/auth/connect-token",
        );
        expect(post?.[1]).toMatchObject({
            method: "POST",
            headers: { "Content-Type": "application/json" },
        });
        expect(JSON.parse(post?.[1].body ?? "{}")).toEqual({
            accessToken: NEW_TOKEN,
            apiBase: "https://api.plaud.ai",
            source: "connector",
        });
        stop();
    });

    it("saves the refreshed token against a custom Plaud server", async () => {
        const h = harness(
            conn({
                tokenExpiresAt: new Date(NOW + HOUR).toISOString(),
                server: "custom",
                apiBase: "https://api-custom.plaud.ai",
            }),
        );
        const stop = startPlaudTokenRefresher({
            fetchApp: h.fetchApp,
            refresh: h.refresh,
            log: h.log,
        });
        await vi.advanceTimersByTimeAsync(60_000);
        const post = h.fetchApp.mock.calls.find(
            ([path]) => path === "/api/plaud/auth/connect-token",
        );
        expect(JSON.parse(post?.[1].body ?? "{}").apiBase).toBe(
            "https://api-custom.plaud.ai",
        );
        stop();
    });

    it("does nothing when not connected", async () => {
        const h = harness({ connected: false });
        const stop = startPlaudTokenRefresher({
            fetchApp: h.fetchApp,
            refresh: h.refresh,
            log: h.log,
        });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(h.refresh).not.toHaveBeenCalled();
        expect(h.fetchApp).toHaveBeenCalledTimes(1);
        stop();
    });

    it("posts nothing when no fresh token arrives", async () => {
        const h = harness(conn({ needsReconnect: true }), null);
        const stop = startPlaudTokenRefresher({
            fetchApp: h.fetchApp,
            refresh: h.refresh,
            log: h.log,
        });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(h.refresh).toHaveBeenCalledTimes(1);
        expect(h.fetchApp.mock.calls.map(([path]) => path)).toEqual([
            "/api/plaud/connection",
        ]);
        stop();
    });

    it("logs and keeps running when a check throws", async () => {
        const h = harness(conn());
        h.fetchApp.mockRejectedValueOnce(new Error("app is down"));
        const stop = startPlaudTokenRefresher({
            fetchApp: h.fetchApp,
            refresh: h.refresh,
            log: h.log,
            intervalMs: 1000,
        });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(h.logged()).toContain("app is down");
        expect(h.fetchApp.mock.calls.length).toBeGreaterThan(1);
        stop();
    });

    it("never logs the token", async () => {
        const h = harness(conn({ needsReconnect: true }));
        const stop = startPlaudTokenRefresher({
            fetchApp: h.fetchApp,
            refresh: h.refresh,
            log: h.log,
            refreshBeforeMs: 0,
        });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(h.log).toHaveBeenCalled();
        expect(h.logged()).not.toContain(NEW_TOKEN);
        expect(h.logged()).not.toContain(TOKEN);
        stop();
    });

    it("stops scheduling after stop()", async () => {
        const h = harness(conn());
        const stop = startPlaudTokenRefresher({
            fetchApp: h.fetchApp,
            refresh: h.refresh,
            log: h.log,
            intervalMs: 1000,
        });
        stop();
        await vi.advanceTimersByTimeAsync(120_000);
        expect(h.fetchApp).not.toHaveBeenCalled();
    });
});
