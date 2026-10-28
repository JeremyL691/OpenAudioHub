import { describe, expect, it } from "vitest";
import {
    DUE_WITHIN,
    TAB_GUARD,
    isDue,
    isNewer,
    isRefreshKey,
    mayOpenTab,
    newRefreshKey,
    tokenExpiry,
    type RefreshEntry,
} from "../../src/refresh";

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: "HS256" })}.${b64(claims)}.c2lnbmF0dXJl`;

const now = 1_800_000_000_000;

function entry(overrides: Partial<RefreshEntry> = {}): RefreshEntry {
    return {
        origin: "http://127.0.0.1:38400",
        refreshKey: "a".repeat(43),
        site: "global",
        lastExp: now + 24 * 60 * 60_000,
        addedAt: now,
        ...overrides,
    };
}

describe("refresh keys", () => {
    it("makes 43-character base64url keys that differ", () => {
        const first = newRefreshKey();
        expect(isRefreshKey(first)).toBe(true);
        expect(newRefreshKey()).not.toBe(first);
    });

    it("refuses other shapes", () => {
        expect(isRefreshKey("a".repeat(42))).toBe(false);
        expect(isRefreshKey(`${"a".repeat(42)}=`)).toBe(false);
        expect(isRefreshKey("")).toBe(false);
    });
});

describe("tokenExpiry", () => {
    it("reads exp in milliseconds", () => {
        expect(tokenExpiry(jwt({ sub: "x", exp: 1_800_000_000 }))).toBe(1_800_000_000_000);
    });

    it("is null without exp or for a value that is not a token", () => {
        expect(tokenExpiry(jwt({ sub: "x" }))).toBeNull();
        expect(tokenExpiry("not-a-token")).toBeNull();
    });
});

describe("isNewer", () => {
    it("compares with the last expiry the server took", () => {
        expect(isNewer(now + 25 * 60 * 60_000, entry())).toBe(true);
        expect(isNewer(now + 24 * 60 * 60_000, entry())).toBe(false);
        expect(isNewer(null, entry())).toBe(false);
        expect(isNewer(now, entry({ lastExp: null }))).toBe(true);
    });
});

describe("isDue", () => {
    it("is due within six hours of expiry or after it", () => {
        expect(isDue(entry(), now)).toBe(false);
        expect(isDue(entry({ lastExp: now + DUE_WITHIN }), now)).toBe(true);
        expect(isDue(entry({ lastExp: now - 1 }), now)).toBe(true);
        expect(isDue(entry({ lastExp: null }), now)).toBe(false);
    });
});

describe("mayOpenTab", () => {
    it("opens at most one tab per token in the guard time", () => {
        const lastExp = now + 1000;
        expect(mayOpenTab(entry({ lastExp }), now)).toBe(true);
        expect(mayOpenTab(entry({ lastExp, tabAt: now - 1000, tabExp: lastExp }), now)).toBe(false);
        expect(mayOpenTab(entry({ lastExp, tabAt: now - TAB_GUARD, tabExp: lastExp }), now)).toBe(true);
        expect(mayOpenTab(entry({ lastExp, tabAt: now - 1000, tabExp: lastExp - 1 }), now)).toBe(true);
    });
});
