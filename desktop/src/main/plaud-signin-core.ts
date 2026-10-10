/** Pure helpers for the Plaud sign-in window. No electron import, so they are unit-testable. */

export const PLAUD_WEB_ORIGINS: readonly string[] = [
    "https://web.plaud.ai",
    "https://web.plaud.cn",
];
export const PLAUD_SIGNIN_PARTITION = "persist:plaud-signin";
export const PLAUD_UT_COOKIE = "pld_ut";
export type PlaudRegion = "global" | "euc1" | "apse1" | "unknown";
export interface PlaudConnectPayload {
    accessToken: string;
    apiBase: string;
    region: PlaudRegion;
    capturedAt: number;
}

const JWT_SEGMENT = /^[A-Za-z0-9_-]+$/;
const PLAUD_API_HOST = /^api(-[a-z0-9]+)?\.plaud\.(ai|cn)$/i;
const REGION_API_BASES: ReadonlyMap<string, string> = new Map([
    ["aws:us-west-2", "https://api.plaud.ai"],
    ["aws:eu-central-1", "https://api-euc1.plaud.ai"],
    ["aws:ap-southeast-1", "https://api-apse1.plaud.ai"],
]);

function decodeJsonObject(segment: string): Record<string, unknown> | null {
    try {
        const parsed: unknown = JSON.parse(
            Buffer.from(segment, "base64url").toString("utf8"),
        );
        return typeof parsed === "object" &&
            parsed !== null &&
            !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
}

function stripBearer(value: string): string {
    return value.replace(/^bearer\s+/i, "").trim();
}

/** true for a three-segment base64url token with a JSON header that declares `alg` and plausible segment lengths. */
export function looksLikeJwt(candidate: string): boolean {
    const segments = candidate.split(".");
    if (segments.length !== 3) return false;
    if (!segments.every((seg) => JWT_SEGMENT.test(seg))) return false;
    const [header, payload, signature] = segments as [string, string, string];
    if (header.length < 10 || payload.length < 16 || signature.length < 16)
        return false;
    return typeof decodeJsonObject(header)?.alg === "string";
}

/** localStorage "pld_tokenstr" holds a JSON-encoded string like "\"bearer eyJ...\"". Returns the bare JWT or null. */
export function parsePldTokenstr(raw: unknown): string | null {
    if (typeof raw !== "string" || raw.length === 0) return null;
    let value: string = raw;
    try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed === "string") value = parsed;
    } catch {
        value = raw;
    }
    const token = stripBearer(value);
    return looksLikeJwt(token) ? token : null;
}

/**
 * Cookie "pld_ut" (HttpOnly, set for Google and Apple logins) may be bearer-prefixed, quoted or URL-encoded.
 * Returns the bare JWT or null.
 */
export function parseUtCookie(value: unknown): string | null {
    if (typeof value !== "string") return null;
    let token = value.trim();
    if (token.length >= 2 && token.startsWith('"') && token.endsWith('"'))
        token = token.slice(1, -1).trim();
    token = stripBearer(token);
    if (token.includes("%")) {
        try {
            token = stripBearer(decodeURIComponent(token));
        } catch {
            return null;
        }
    }
    return looksLikeJwt(token) ? token : null;
}

/** Maps the JWT payload `region` claim to the matching .ai API base, or null when the claim is absent or unknown. */
export function apiBaseFromTokenRegion(token: string): string | null {
    const payloadSegment = token.split(".")[1];
    if (!payloadSegment) return null;
    const region = decodeJsonObject(payloadSegment)?.region;
    return typeof region === "string"
        ? (REGION_API_BASES.get(region) ?? null)
        : null;
}

/** Seconds-since-epoch `exp` claim from a JWT payload, or null if absent/undecodable. */
export function jwtExpiry(token: string): number | null {
    const payloadSegment = token.split(".")[1];
    if (!payloadSegment) return null;
    try {
        const claims: unknown = JSON.parse(
            Buffer.from(payloadSegment, "base64url").toString("utf8"),
        );
        if (typeof claims !== "object" || claims === null) return null;
        const exp = (claims as { exp?: unknown }).exp;
        return typeof exp === "number" && Number.isFinite(exp) ? exp : null;
    } catch {
        return null;
    }
}

/** true when exp exists and exp*1000 <= nowMs. Tokens without exp are NOT expired. */
export function isTokenExpired(token: string, nowMs: number): boolean {
    const exp = jwtExpiry(token);
    return exp !== null && exp * 1000 <= nowMs;
}

/** hostname matches api(-region).plaud.ai or .cn (case-insensitive). */
export function isPlaudApiHost(hostname: string): boolean {
    return PLAUD_API_HOST.test(hostname);
}

/** For an https URL on a Plaud API host, returns `https://<host>` (lowercased, no port); else null. */
export function apiBaseFromRequestUrl(url: string): string | null {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:" || parsed.port !== "") return null;
        const host = parsed.hostname.toLowerCase();
        return isPlaudApiHost(host) ? `https://${host}` : null;
    } catch {
        return null;
    }
}

/** "https://web.plaud.cn" -> "https://api.plaud.cn"; anything else -> "https://api.plaud.ai". */
export function defaultApiBaseForWebOrigin(origin: string): string {
    return origin === "https://web.plaud.cn"
        ? "https://api.plaud.cn"
        : "https://api.plaud.ai";
}

/** Maps an API base URL to its region. Invalid URLs and non-Plaud hosts are "unknown". */
export function regionOf(apiBase: string): PlaudRegion {
    let host: string;
    try {
        host = new URL(apiBase).hostname.toLowerCase();
    } catch {
        return "unknown";
    }
    if (host.includes("euc1")) return "euc1";
    if (host.includes("apse1")) return "apse1";
    if (host === "api.plaud.ai") return "global";
    return "unknown";
}

/** URL origin is one of PLAUD_WEB_ORIGINS. Invalid URLs are false. */
export function isPlaudWebUrl(url: string): boolean {
    try {
        return PLAUD_WEB_ORIGINS.includes(new URL(url).origin);
    } catch {
        return false;
    }
}

/** Removes Electron and app product tokens from a user agent. Google refuses sign-in when the UA advertises Electron. */
export function chromeLikeUserAgent(ua: string): string {
    return ua
        .replace(/ (Electron|OpenAudioHub|openaudiohub)\/\S+/gi, "")
        .replace(/ {2,}/g, " ")
        .trim();
}

/** Navigation allowed in the sign-in window: only https: URLs, plus exactly "about:blank". */
export function isSigninNavigationAllowed(url: string): boolean {
    if (url === "about:blank") return true;
    try {
        return new URL(url).protocol === "https:";
    } catch {
        return false;
    }
}
