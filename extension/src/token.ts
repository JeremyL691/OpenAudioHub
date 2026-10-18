export type Site = "global" | "cn";

export type TokenClaims = Record<string, unknown>;

export interface AcceptedToken {
    accessToken: string;
    apiBase: string;
}

const PART = /^[A-Za-z0-9_-]+$/;

const REGION_BASES: Record<string, string> = {
    "aws:us-west-2": "https://api.plaud.ai",
    "aws:eu-central-1": "https://api-euc1.plaud.ai",
    "aws:ap-southeast-1": "https://api-apse1.plaud.ai",
};

/** Applies the cleaning steps to a raw cookie or storage value. `null` means it cannot be used. */
export function cleanToken(raw: string): string | null {
    let value = raw.trim();
    if (value.includes("%")) {
        try {
            value = decodeURIComponent(value);
        } catch {
            return null;
        }
    }
    if (value.startsWith('"')) {
        try {
            const parsed: unknown = JSON.parse(value);
            if (typeof parsed !== "string") return null;
            value = parsed;
        } catch {
            return null;
        }
    }
    if (value.startsWith("bearer ") || value.startsWith("Bearer ")) {
        value = value.slice(7);
    }
    return value.trim();
}

/** The three-part shape, the allowed characters, and the minimum length. */
export function isTokenShape(value: string): boolean {
    if (value.length <= 20) return false;
    const parts = value.split(".");
    if (parts.length !== 3) return false;
    return parts.every((part) => PART.test(part));
}

function decodeBase64Url(part: string): string | null {
    const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    try {
        const binary = atob(padded);
        const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
        return new TextDecoder().decode(bytes);
    } catch {
        return null;
    }
}

/** The payload claims of a token, or `null` when the token cannot be read. */
export function decodeClaims(value: string): TokenClaims | null {
    if (!isTokenShape(value)) return null;
    const payload = value.split(".")[1];
    if (payload === undefined) return null;
    const json = decodeBase64Url(payload);
    if (json === null) return null;
    try {
        const parsed: unknown = JSON.parse(json);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
        return parsed as TokenClaims;
    } catch {
        return null;
    }
}

/** The API base for the token's region claim. */
export function apiBaseForClaims(claims: TokenClaims, site: Site): string {
    const region = claims.region;
    if (typeof region === "string" && region in REGION_BASES) {
        return REGION_BASES[region] as string;
    }
    return site === "cn" ? "https://api.plaud.cn" : "https://api.plaud.ai";
}

/** Cleans, validates and derives the API base. `null` means the value is not usable yet. */
export function acceptToken(raw: string, site: Site, now = Date.now()): AcceptedToken | null {
    const accessToken = cleanToken(raw);
    if (accessToken === null) return null;
    const claims = decodeClaims(accessToken);
    if (claims === null) return null;
    if ("ut_ref" in claims || "wid" in claims) return null;
    if ("exp" in claims) {
        const exp = claims.exp;
        if (typeof exp !== "number" || !Number.isFinite(exp)) return null;
        if (exp * 1000 <= now + 60_000) return null;
    }
    return { accessToken, apiBase: apiBaseForClaims(claims, site) };
}
