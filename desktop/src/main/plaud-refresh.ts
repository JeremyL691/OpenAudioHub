/**
 * Keeps the Plaud token fresh while the app runs. Plaud tokens last 24 hours; the Plaud web session in the sign-in
 * partition hands out a new one on page load, so the main process captures it silently and posts it to the app. The
 * window does not need to be open. The token never reaches the log.
 */
import type { PlaudConnectPayload } from "./plaud-signin-core.js";

/** The part of GET /api/plaud/connection the refresher reads. */
export interface PlaudConnectionStatus {
    connected: boolean;
    needsReconnect?: boolean;
    /** ISO time the stored token expires, or null when it cannot be read. */
    tokenExpiresAt?: string | null;
    server?: string;
}

export interface AppResponse {
    status: number;
    json(): Promise<unknown>;
}

/** Calls the app server with the app's session. `path` is relative to the app origin. */
export type FetchApp = (
    path: string,
    init: { method: string; headers?: Record<string, string>; body?: string },
) => Promise<AppResponse>;

export interface PlaudTokenRefresherOptions {
    fetchApp: FetchApp;
    /** Captures a fresh token; resolves null when none arrived. minExpiry is the stored token's expiry (0 if unknown). */
    refresh: (
        currentExpiryMs: number,
        connection: PlaudConnectionStatus,
    ) => Promise<PlaudConnectPayload | null>;
    log: (message: string) => void;
    intervalMs?: number;
    refreshBeforeMs?: number;
    /** Delay before the first check, so start-up is not slowed down. */
    firstRunDelayMs?: number;
}

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
const DEFAULT_REFRESH_BEFORE_MS = 6 * 60 * 60 * 1000;
const DEFAULT_FIRST_RUN_DELAY_MS = 60 * 1000;

/**
 * Refresh when Plaud has rejected the token, or when it expires within refreshBeforeMs. A connection whose expiry is
 * unknown is refreshed only after a rejection.
 */
export function shouldRefresh(
    connection: PlaudConnectionStatus,
    nowMs: number,
    refreshBeforeMs: number,
): boolean {
    if (!connection.connected) return false;
    if (connection.needsReconnect) return true;
    if (!connection.tokenExpiresAt) return false;
    const expiresAtMs = Date.parse(connection.tokenExpiresAt);
    if (Number.isNaN(expiresAtMs)) return false;
    return expiresAtMs - nowMs <= refreshBeforeMs;
}

function parseConnection(body: unknown): PlaudConnectionStatus | null {
    if (typeof body !== "object" || body === null) return null;
    const record = body as Record<string, unknown>;
    if (typeof record.connected !== "boolean") return null;
    return {
        connected: record.connected,
        needsReconnect: record.needsReconnect === true,
        tokenExpiresAt:
            typeof record.tokenExpiresAt === "string"
                ? record.tokenExpiresAt
                : null,
        server: typeof record.server === "string" ? record.server : undefined,
    };
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** One check: read the connection, refresh when due, and post the new token to the app. */
async function checkOnce(
    options: PlaudTokenRefresherOptions,
    refreshBeforeMs: number,
    isStopped: () => boolean,
): Promise<void> {
    const { fetchApp, refresh, log } = options;
    const response = await fetchApp("/api/plaud/connection", {
        method: "GET",
    });
    if (response.status !== 200) {
        log(`plaud token check skipped: the app answered ${response.status}`);
        return;
    }
    const connection = parseConnection(await response.json());
    if (!connection) {
        log("plaud token check skipped: unexpected connection response");
        return;
    }
    if (!shouldRefresh(connection, Date.now(), refreshBeforeMs)) return;

    const currentExpiryMs = connection.tokenExpiresAt
        ? Date.parse(connection.tokenExpiresAt)
        : 0;
    const payload = await refresh(currentExpiryMs, connection);
    if (!payload) {
        log("plaud token refresh: no new token from Plaud");
        return;
    }
    if (isStopped()) return;

    const posted = await fetchApp("/api/plaud/auth/connect-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            accessToken: payload.accessToken,
            apiBase: payload.apiBase,
            source: "connector",
        }),
    });
    if (posted.status === 200) {
        log("plaud token refreshed");
    } else {
        log(
            `plaud token refresh: the app rejected the new token (status ${posted.status})`,
        );
    }
}

/**
 * Starts the periodic check. Runs one check after firstRunDelayMs, then every intervalMs; a check still running is
 * not overlapped. Errors are logged, never thrown. Returns the stop function.
 */
export function startPlaudTokenRefresher(
    options: PlaudTokenRefresherOptions,
): () => void {
    const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    const refreshBeforeMs =
        options.refreshBeforeMs ?? DEFAULT_REFRESH_BEFORE_MS;
    const firstRunDelayMs =
        options.firstRunDelayMs ?? DEFAULT_FIRST_RUN_DELAY_MS;
    let stopped = false;
    let busy = false;

    const tick = (): void => {
        if (stopped || busy) return;
        busy = true;
        checkOnce(options, refreshBeforeMs, () => stopped)
            .catch((error: unknown) => {
                options.log(`plaud token refresh failed: ${errorText(error)}`);
            })
            .finally(() => {
                busy = false;
            });
    };

    const firstTimer = setTimeout(tick, firstRunDelayMs);
    const timer = setInterval(tick, intervalMs);
    return () => {
        stopped = true;
        clearTimeout(firstTimer);
        clearInterval(timer);
    };
}
