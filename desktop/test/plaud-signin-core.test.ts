import { describe, expect, it } from "vitest";
import {
    apiBaseFromRequestUrl,
    apiBaseFromTokenRegion,
    chromeLikeUserAgent,
    defaultApiBaseForWebOrigin,
    isPlaudApiHost,
    isPlaudWebUrl,
    isSigninNavigationAllowed,
    isTokenExpired,
    jwtExpiry,
    looksLikeJwt,
    parsePldTokenstr,
    parseUtCookie,
    regionOf,
} from "../src/main/plaud-signin-core.js";

const TEST_SIGNATURE = "signature-0123456789abcdef";

function b64url(value: unknown): string {
    return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function makeJwt(claims: Record<string, unknown>): string {
    return `${b64url({ alg: "HS256", typ: "UT" })}.${b64url(claims)}.${TEST_SIGNATURE}`;
}

describe("looksLikeJwt", () => {
    it("accepts a realistic token", () => {
        expect(looksLikeJwt(makeJwt({ sub: "u1", exp: 9999999999 }))).toBe(
            true,
        );
    });

    it("rejects the wrong segment count and characters", () => {
        expect(looksLikeJwt("1.3.6")).toBe(false);
        expect(looksLikeJwt(`${makeJwt({ sub: "u1" })}.extra`)).toBe(false);
        expect(
            looksLikeJwt(`${b64url({ alg: "HS256" })}+.x.${TEST_SIGNATURE}`),
        ).toBe(false);
    });

    it("rejects short segments", () => {
        expect(
            looksLikeJwt(
                `${b64url({ alg: "HS256" })}.${b64url({ sub: "u1" })}.short`,
            ),
        ).toBe(false);
        expect(
            looksLikeJwt(`abc.${b64url({ sub: "u1" })}.${TEST_SIGNATURE}`),
        ).toBe(false);
    });

    it("rejects a header that is not a JSON object with a string alg", () => {
        const payload = b64url({ sub: "u1" });
        expect(
            looksLikeJwt(
                `${b64url("hello world header")}.${payload}.${TEST_SIGNATURE}`,
            ),
        ).toBe(false);
        expect(
            looksLikeJwt(
                `${b64url({ typ: "UT" })}.${payload}.${TEST_SIGNATURE}`,
            ),
        ).toBe(false);
    });
});

describe("apiBaseFromTokenRegion", () => {
    it("maps known region claims to their API base", () => {
        expect(
            apiBaseFromTokenRegion(makeJwt({ region: "aws:us-west-2" })),
        ).toBe("https://api.plaud.ai");
        expect(
            apiBaseFromTokenRegion(makeJwt({ region: "aws:eu-central-1" })),
        ).toBe("https://api-euc1.plaud.ai");
        expect(
            apiBaseFromTokenRegion(makeJwt({ region: "aws:ap-southeast-1" })),
        ).toBe("https://api-apse1.plaud.ai");
    });

    it("returns null for unknown, missing or non-string regions and malformed tokens", () => {
        expect(
            apiBaseFromTokenRegion(makeJwt({ region: "aws:mars-1" })),
        ).toBeNull();
        expect(apiBaseFromTokenRegion(makeJwt({ region: 7 }))).toBeNull();
        expect(apiBaseFromTokenRegion(makeJwt({ sub: "u1" }))).toBeNull();
        expect(apiBaseFromTokenRegion("1.3.6")).toBeNull();
        expect(apiBaseFromTokenRegion("")).toBeNull();
    });
});

describe("parseUtCookie", () => {
    const jwt = makeJwt({ sub: "u1" });

    it("accepts a plain JWT", () => {
        expect(parseUtCookie(jwt)).toBe(jwt);
        expect(parseUtCookie(`  ${jwt} `)).toBe(jwt);
    });

    it("strips surrounding quotes", () => {
        expect(parseUtCookie(`"${jwt}"`)).toBe(jwt);
    });

    it("strips a bearer prefix in any case, with or without quotes", () => {
        expect(parseUtCookie(`bearer ${jwt}`)).toBe(jwt);
        expect(parseUtCookie(`Bearer   ${jwt}`)).toBe(jwt);
        expect(parseUtCookie(`"BEARER ${jwt}"`)).toBe(jwt);
    });

    it("URL-decodes encoded values", () => {
        expect(parseUtCookie(encodeURIComponent(`bearer ${jwt}`))).toBe(jwt);
        expect(parseUtCookie(encodeURIComponent(jwt))).toBe(jwt);
    });

    it("returns null for garbage, short tokens and invalid encodings", () => {
        expect(parseUtCookie("1.3.6")).toBeNull();
        expect(parseUtCookie("not a token")).toBeNull();
        expect(parseUtCookie("")).toBeNull();
        expect(parseUtCookie('""')).toBeNull();
        expect(parseUtCookie("%E0%A4%A")).toBeNull();
        expect(parseUtCookie(42)).toBeNull();
        expect(parseUtCookie(undefined)).toBeNull();
    });
});

describe("parsePldTokenstr", () => {
    const jwt = makeJwt({ sub: "u1" });

    it("unwraps a JSON-encoded bearer string", () => {
        expect(parsePldTokenstr(JSON.stringify(`bearer ${jwt}`))).toBe(jwt);
        expect(parsePldTokenstr(JSON.stringify(`Bearer   ${jwt}`))).toBe(jwt);
    });

    it("accepts a plain JWT string", () => {
        expect(parsePldTokenstr(jwt)).toBe(jwt);
        expect(parsePldTokenstr(`  ${jwt}  `)).toBe(jwt);
    });

    it("returns null for non-strings and empty input", () => {
        expect(parsePldTokenstr(undefined)).toBeNull();
        expect(parsePldTokenstr(null)).toBeNull();
        expect(parsePldTokenstr(42)).toBeNull();
        expect(parsePldTokenstr("")).toBeNull();
    });

    it("returns null for garbage and workspace-like two-segment tokens", () => {
        expect(parsePldTokenstr("not a token")).toBeNull();
        expect(parsePldTokenstr('""')).toBeNull();
        expect(parsePldTokenstr("abc.def")).toBeNull();
        expect(parsePldTokenstr("abc.def.")).toBeNull();
        expect(parsePldTokenstr("a+b.c.d")).toBeNull();
        expect(parsePldTokenstr(JSON.stringify({ token: jwt }))).toBeNull();
    });
});

describe("jwtExpiry and isTokenExpired", () => {
    const now = 1_000_000_000_000;
    const nowSec = now / 1000;

    it("reads the exp claim in seconds", () => {
        expect(jwtExpiry(makeJwt({ exp: 1234 }))).toBe(1234);
    });

    it("returns null when exp is absent or the payload is undecodable", () => {
        expect(jwtExpiry(makeJwt({ sub: "x" }))).toBeNull();
        expect(jwtExpiry(makeJwt({ exp: "soon" }))).toBeNull();
        expect(jwtExpiry("a.!!!.c")).toBeNull();
        expect(jwtExpiry("a.bm90IGpzb24.c")).toBeNull();
        expect(jwtExpiry("onlyonesegment")).toBeNull();
    });

    it("flags expired tokens, including exactly at the boundary", () => {
        expect(isTokenExpired(makeJwt({ exp: nowSec - 1 }), now)).toBe(true);
        expect(isTokenExpired(makeJwt({ exp: nowSec }), now)).toBe(true);
    });

    it("keeps unexpired tokens valid", () => {
        expect(isTokenExpired(makeJwt({ exp: nowSec + 60 }), now)).toBe(false);
    });

    it("never treats a token without exp as expired", () => {
        expect(isTokenExpired(makeJwt({ sub: "x" }), now)).toBe(false);
    });
});

describe("Plaud API hosts", () => {
    it("accepts api, regional and cn hosts case-insensitively", () => {
        expect(isPlaudApiHost("api.plaud.ai")).toBe(true);
        expect(isPlaudApiHost("API-euc1.plaud.ai")).toBe(true);
        expect(isPlaudApiHost("api-apse1.plaud.ai")).toBe(true);
        expect(isPlaudApiHost("api.plaud.cn")).toBe(true);
    });

    it("rejects other hosts", () => {
        expect(isPlaudApiHost("web.plaud.ai")).toBe(false);
        expect(isPlaudApiHost("api.plaud.ai.evil.com")).toBe(false);
        expect(isPlaudApiHost("evilapi.plaud.ai")).toBe(false);
    });

    it("builds an https api base from a request URL", () => {
        expect(
            apiBaseFromRequestUrl("https://API-euc1.plaud.ai/file/list?x=1"),
        ).toBe("https://api-euc1.plaud.ai");
        expect(apiBaseFromRequestUrl("https://api.plaud.cn/me")).toBe(
            "https://api.plaud.cn",
        );
    });

    it("rejects http, explicit ports, foreign hosts and invalid URLs", () => {
        expect(apiBaseFromRequestUrl("http://api.plaud.ai/me")).toBeNull();
        expect(
            apiBaseFromRequestUrl("https://api.plaud.ai:8443/me"),
        ).toBeNull();
        expect(apiBaseFromRequestUrl("https://example.com/me")).toBeNull();
        expect(apiBaseFromRequestUrl("not a url")).toBeNull();
    });

    it("defaults the api base from the web origin", () => {
        expect(defaultApiBaseForWebOrigin("https://web.plaud.cn")).toBe(
            "https://api.plaud.cn",
        );
        expect(defaultApiBaseForWebOrigin("https://web.plaud.ai")).toBe(
            "https://api.plaud.ai",
        );
        expect(defaultApiBaseForWebOrigin("https://other.example")).toBe(
            "https://api.plaud.ai",
        );
    });

    it("maps api bases to regions", () => {
        expect(regionOf("https://api.plaud.ai")).toBe("global");
        expect(regionOf("https://api-euc1.plaud.ai")).toBe("euc1");
        expect(regionOf("https://api-apse1.plaud.ai")).toBe("apse1");
        expect(regionOf("https://api.plaud.cn")).toBe("unknown");
        expect(regionOf("not a url")).toBe("unknown");
    });
});

describe("isPlaudWebUrl", () => {
    it("accepts the Plaud web origins, including paths", () => {
        expect(isPlaudWebUrl("https://web.plaud.ai/")).toBe(true);
        expect(isPlaudWebUrl("https://web.plaud.cn/login?x=1")).toBe(true);
    });

    it("rejects userinfo tricks, other origins and invalid URLs", () => {
        expect(isPlaudWebUrl("https://web.plaud.ai@evil.com")).toBe(false);
        expect(isPlaudWebUrl("https://web.plaud.ai.evil.com/")).toBe(false);
        expect(isPlaudWebUrl("http://web.plaud.ai/")).toBe(false);
        expect(isPlaudWebUrl("not a url")).toBe(false);
    });
});

describe("chromeLikeUserAgent", () => {
    it("strips Electron and app tokens and collapses spaces", () => {
        const ua =
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) openaudiohub/1.1.0 Chrome/140.0.7339.41 Electron/44.7.0 Safari/537.36";
        expect(chromeLikeUserAgent(ua)).toBe(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.41 Safari/537.36",
        );
    });

    it("strips the OpenAudioHub token in any case", () => {
        expect(chromeLikeUserAgent("Chrome/1 OpenAudioHub/2.0  Safari/3")).toBe(
            "Chrome/1 Safari/3",
        );
    });

    it("leaves a clean user agent unchanged", () => {
        expect(
            chromeLikeUserAgent("Mozilla/5.0 Chrome/140 Safari/537.36"),
        ).toBe("Mozilla/5.0 Chrome/140 Safari/537.36");
    });
});

describe("isSigninNavigationAllowed", () => {
    it("allows https URLs and exactly about:blank", () => {
        expect(isSigninNavigationAllowed("https://web.plaud.ai/login")).toBe(
            true,
        );
        expect(
            isSigninNavigationAllowed("https://accounts.google.com/signin"),
        ).toBe(true);
        expect(isSigninNavigationAllowed("about:blank")).toBe(true);
    });

    it("rejects http, other about: URLs, other schemes and invalid input", () => {
        expect(isSigninNavigationAllowed("http://web.plaud.ai/")).toBe(false);
        expect(isSigninNavigationAllowed("about:srcdoc")).toBe(false);
        expect(isSigninNavigationAllowed("file:///etc/passwd")).toBe(false);
        expect(isSigninNavigationAllowed("javascript:alert(1)")).toBe(false);
        expect(isSigninNavigationAllowed("not a url")).toBe(false);
    });
});
