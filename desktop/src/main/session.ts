/** Exchanges the launch secret for the local account's session cookie (PLAN D-304, D-320). */

export interface SessionFetchInit {
    method: string;
    headers: Record<string, string>;
}

export type SessionFetch = (
    url: string,
    init: SessionFetchInit,
) => Promise<{ status: number }>;

export interface ExchangeOptions {
    /** Origin of the app server, for example http://127.0.0.1:38400. */
    appOrigin: string;
    launchSecret: string;
    /** fetch bound to the window's session partition (`session.fromPartition('persist:oah').fetch`). */
    fetch: SessionFetch;
    attempts?: number;
    retryDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
}

export class SessionExchangeError extends Error {
    constructor(
        message: string,
        readonly status: number | null,
    ) {
        super(message);
        this.name = "SessionExchangeError";
    }
}

/**
 * POSTs to /api/desktop/session with the launch secret. The server answers 204 with Set-Cookie, and
 * the partition's fetch stores the cookie. The Host header is set by the request itself, so it
 * matches the loopback origin the server checks.
 */
export async function exchangeSession(options: ExchangeOptions): Promise<void> {
    const attempts = options.attempts ?? 5;
    const retryDelayMs = options.retryDelayMs ?? 500;
    const sleep =
        options.sleep ??
        ((ms: number) =>
            new Promise<void>((resolve) => setTimeout(resolve, ms)));
    let lastStatus: number | null = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            const response = await options.fetch(
                new URL("/api/desktop/session", options.appOrigin).toString(),
                {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${options.launchSecret}`,
                    },
                },
            );
            lastStatus = response.status;
            if (response.status === 204) return;
            if (
                response.status === 401 ||
                response.status === 403 ||
                response.status === 404
            ) {
                // Configuration errors do not get better with retries.
                break;
            }
        } catch {
            lastStatus = null;
        }
        if (attempt < attempts) await sleep(retryDelayMs * attempt);
    }
    throw new SessionExchangeError(
        `the desktop session exchange failed (last status ${lastStatus ?? "none"})`,
        lastStatus,
    );
}
