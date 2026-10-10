import { randomBytes } from "node:crypto";

export interface HandoffEntry {
    userId: string;
    expiresAt: number;
    status: "pending" | "connected";
    error?: string;
}

const HANDOFF_TTL_MS = 10 * 60 * 1000;
const MAX_LIVE_HANDOFFS_PER_USER = 5;

const STORE_KEY: unique symbol = Symbol.for("openaudiohub.plaud.handoffStore");

type HandoffGlobal = typeof globalThis & {
    [STORE_KEY]?: Map<string, HandoffEntry>;
};

function getStore(): Map<string, HandoffEntry> {
    const scope = globalThis as HandoffGlobal;
    let store = scope[STORE_KEY];
    if (!store) {
        store = new Map<string, HandoffEntry>();
        scope[STORE_KEY] = store;
    }
    return store;
}

function purgeExpired(store: Map<string, HandoffEntry>, now: number): void {
    for (const [code, entry] of store) {
        if (entry.expiresAt <= now) {
            store.delete(code);
        }
    }
}

/**
 * Create a one-time handoff code bound to a user. The code expires after
 * ten minutes. Each user keeps at most five live codes; creating a sixth
 * drops the oldest.
 */
export function createHandoff(userId: string): {
    code: string;
    expiresAt: number;
} {
    const store = getStore();
    const now = Date.now();
    purgeExpired(store, now);

    const owned = [...store.entries()].filter(
        ([, entry]) => entry.userId === userId,
    );
    const excess = owned.length - (MAX_LIVE_HANDOFFS_PER_USER - 1);
    for (const [code] of owned.slice(0, Math.max(0, excess))) {
        store.delete(code);
    }

    const code = randomBytes(32).toString("base64url");
    const expiresAt = now + HANDOFF_TTL_MS;
    store.set(code, { userId, expiresAt, status: "pending" });
    return { code, expiresAt };
}

/** Look up a live handoff. Returns a copy, or undefined if missing or expired. */
export function getHandoff(code: string): HandoffEntry | undefined {
    const store = getStore();
    purgeExpired(store, Date.now());
    const entry = store.get(code);
    return entry ? { ...entry } : undefined;
}

/** Mark a live handoff as connected. No-op if the code is missing or expired. */
export function markHandoffConnected(code: string): void {
    const store = getStore();
    purgeExpired(store, Date.now());
    const entry = store.get(code);
    if (!entry) {
        return;
    }
    entry.status = "connected";
    delete entry.error;
}

/**
 * Record a failed connect attempt on a live handoff. The entry stays pending
 * so the user can retry until the TTL lapses.
 */
export function markHandoffError(code: string, message: string): void {
    const store = getStore();
    purgeExpired(store, Date.now());
    const entry = store.get(code);
    if (!entry) {
        return;
    }
    entry.error = message;
}

/** Remove a handoff code. No-op if it does not exist. */
export function deleteHandoff(code: string): void {
    const store = getStore();
    purgeExpired(store, Date.now());
    store.delete(code);
}
