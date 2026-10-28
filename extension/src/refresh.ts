import { decodeClaims, type AcceptedToken, type Site } from "./token";

export const REFRESH_STORE = "autoRefresh";
export const RENEWAL_STORE = "renewal";
export const REFRESH_ALARM = "plaud-refresh";
export const RENEWAL_ALARM = "plaud-renewal-end";
export const REFRESH_PERIOD_MINUTES = 30;
/** A token is renewed once it has less than this left. */
export const DUE_WITHIN = 6 * 60 * 60_000;
/** The Plaud tab is opened at most once in this time for the same token. */
export const TAB_GUARD = 6 * 60 * 60_000;
/** How long a renewal tab may stay open. */
export const RENEWAL_WAIT = 60_000;
const PUSH_TIMEOUT = 20_000;
const KEEP = 5;

/** One OpenAudioHub server this browser keeps connected. The token itself is never stored. */
export interface RefreshEntry {
    origin: string;
    refreshKey: string;
    site: Site;
    /** Expiry of the last token the server took, in epoch milliseconds. */
    lastExp: number | null;
    addedAt: number;
    /** When the extension last opened a Plaud tab for this entry, and for which expiry. */
    tabAt?: number;
    tabExp?: number | null;
}

/** A Plaud tab the extension opened to renew the sign-in. */
export interface Renewal {
    tabId: number;
    site: Site;
}

export type PushOutcome = "updated" | "unchanged" | "drop" | "retry";

const KEY_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export function isRefreshKey(value: string): boolean {
    return KEY_SHAPE.test(value);
}

/** 32 random bytes in base64url. */
export function newRefreshKey(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The token's expiry in epoch milliseconds, or `null` when it has none. */
export function tokenExpiry(token: string): number | null {
    const exp = decodeClaims(token)?.exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null;
}

/** True when the token is newer than the one the server has. */
export function isNewer(exp: number | null, entry: RefreshEntry): boolean {
    if (exp === null) return false;
    return entry.lastExp === null || exp > entry.lastExp;
}

/** True when the server's token expires soon or has expired. */
export function isDue(entry: RefreshEntry, now: number): boolean {
    return entry.lastExp !== null && entry.lastExp - now <= DUE_WITHIN;
}

/** False while a Plaud tab was opened recently for the same token. */
export function mayOpenTab(entry: RefreshEntry, now: number): boolean {
    if (entry.tabAt === undefined) return true;
    if (entry.tabExp !== entry.lastExp) return true;
    return now - entry.tabAt >= TAB_GUARD;
}

export async function readEntries(): Promise<RefreshEntry[]> {
    const stored = await chrome.storage.local.get(REFRESH_STORE);
    const map = stored[REFRESH_STORE] as Record<string, RefreshEntry> | undefined;
    return map === undefined ? [] : Object.values(map);
}

async function writeEntries(entries: RefreshEntry[]): Promise<void> {
    const kept = [...entries].sort((a, b) => b.addedAt - a.addedAt).slice(0, KEEP);
    await chrome.storage.local.set({ [REFRESH_STORE]: Object.fromEntries(kept.map((e) => [e.origin, e])) });
}

/** Adds or replaces the entry for its origin. */
export async function saveEntry(entry: RefreshEntry): Promise<void> {
    const others = (await readEntries()).filter((e) => e.origin !== entry.origin);
    await writeEntries([...others, entry]);
}

export async function removeEntry(origin: string): Promise<void> {
    await writeEntries((await readEntries()).filter((e) => e.origin !== origin));
}

export async function readRenewal(): Promise<Renewal | null> {
    const stored = await chrome.storage.session.get(RENEWAL_STORE);
    return (stored[RENEWAL_STORE] as Renewal | undefined) ?? null;
}

export async function writeRenewal(renewal: Renewal | null): Promise<void> {
    if (renewal === null) await chrome.storage.session.remove(RENEWAL_STORE);
    else await chrome.storage.session.set({ [RENEWAL_STORE]: renewal });
}

/** Sends a newer token to the entry's server. Only the server the user confirmed is called. */
export async function push(entry: RefreshEntry, accepted: AcceptedToken): Promise<PushOutcome> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PUSH_TIMEOUT);
    try {
        const response = await fetch(`${entry.origin}/api/plaud/auth/refresh`, {
            method: "POST",
            credentials: "omit",
            headers: { Authorization: `Bearer ${entry.refreshKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ accessToken: accepted.accessToken, apiBase: accepted.apiBase }),
            signal: controller.signal,
        });
        const data = (await response.json().catch(() => ({}))) as { code?: unknown; updated?: unknown };
        if (response.status === 401 && data.code === "PLAUD_REFRESH_KEY_INVALID") return "drop";
        if (response.status === 409) return "drop";
        if (!response.ok) return "retry";
        return data.updated === false ? "unchanged" : "updated";
    } catch {
        return "retry";
    } finally {
        clearTimeout(timer);
    }
}
