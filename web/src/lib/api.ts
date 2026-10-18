/** An error answer from the server, in its common shape `{ error, code, details }`. */
export class ApiError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        message: string,
        readonly details: Record<string, unknown> = {},
    ) {
        super(message);
    }
}

/** Window event fired when any API call answers 403 ACCOUNT_SUSPENDED (see session.ts). */
export const ACCOUNT_SUSPENDED_EVENT = "oah:account-suspended";

/** The user-facing text of a failed call, or the fallback for anything that is not an ApiError. */
export function errorMessage(err: unknown, fallback: string): string {
    return err instanceof ApiError && err.message ? err.message : fallback;
}

/** Calls the server and returns the parsed JSON body. Throws ApiError for any non-2xx answer. */
export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
    const { json, headers, ...rest } = init;
    const res = await fetch(path, {
        credentials: "same-origin",
        ...rest,
        headers: json === undefined ? headers : { "content-type": "application/json", ...headers },
        body: json === undefined ? rest.body : JSON.stringify(json),
    });
    const text = await res.text();
    const body = text ? safeJson(text) : null;
    if (!res.ok) {
        const b = (body ?? {}) as { error?: string; message?: string; code?: string; details?: Record<string, unknown> };
        const code = b.code ?? "HTTP_ERROR";
        if (res.status === 403 && code === "ACCOUNT_SUSPENDED") window.dispatchEvent(new Event(ACCOUNT_SUSPENDED_EVENT));
        throw new ApiError(res.status, code, b.error ?? b.message ?? `Request failed (${res.status})`, b.details);
    }
    return body as T;
}

function safeJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}
