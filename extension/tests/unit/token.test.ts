import { describe, expect, it } from "vitest";
import {
    acceptToken,
    apiBaseForClaims,
    cleanToken,
    decodeClaims,
    isTokenShape,
} from "../../src/token";

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

function token(claims: Record<string, unknown>, filler = "signature"): string {
    return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}.${filler}`;
}

const goodClaims = { sub: "person@example.com", exp: Math.floor(Date.now() / 1000) + 3600 };

describe("cleanToken", () => {
    it("trims spaces", () => {
        expect(cleanToken("  abc.def.ghi  ")).toBe("abc.def.ghi");
    });

    it("decodes percent encoding", () => {
        expect(cleanToken("a%2Eb%2Ec")).toBe("a.b.c");
    });

    it("treats a bad percent sequence as unacceptable", () => {
        expect(cleanToken("a%zz.b.c")).toBeNull();
    });

    it("unwraps a JSON string", () => {
        expect(cleanToken('"abc.def.ghi"')).toBe("abc.def.ghi");
    });

    it("rejects a JSON value that is not a string", () => {
        expect(cleanToken('"abc.def.ghi')).toBeNull();
    });

    it("removes a lower-case bearer prefix", () => {
        expect(cleanToken("bearer abc.def.ghi")).toBe("abc.def.ghi");
    });

    it("removes an upper-case bearer prefix", () => {
        expect(cleanToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    });

    it("combines percent decoding, JSON and the prefix", () => {
        expect(cleanToken("%22Bearer%20abc.def.ghi%22")).toBe("abc.def.ghi");
    });
});

describe("isTokenShape", () => {
    it("accepts three parts of the allowed characters", () => {
        expect(isTokenShape("aaa.bbbbbbbbbbbbbb.ccc")).toBe(true);
    });

    it("rejects two parts", () => {
        expect(isTokenShape("aaa.bbb")).toBe(false);
    });

    it("rejects four parts", () => {
        expect(isTokenShape("aaa.bbb.ccc.ddd")).toBe(false);
    });

    it("rejects a character outside the allowed set", () => {
        expect(isTokenShape("aaa.bb+b.ccc")).toBe(false);
    });

    it("rejects a token of 20 characters", () => {
        const value = `aaa.${"b".repeat(12)}.ccc`;
        expect(value.length).toBe(20);
        expect(isTokenShape(value)).toBe(false);
    });

    it("accepts a token of 21 characters", () => {
        const value = `aaa.${"b".repeat(13)}.ccc`;
        expect(value.length).toBe(21);
        expect(isTokenShape(value)).toBe(true);
    });
});

describe("decodeClaims", () => {
    it("returns the payload object", () => {
        expect(decodeClaims(token(goodClaims))).toEqual(goodClaims);
    });

    it("rejects a payload that is not JSON", () => {
        expect(decodeClaims("aaa.!!!.ccc")).toBeNull();
        expect(decodeClaims("aaa." + Buffer.from("[]").toString("base64url") + ".ccc")).toBeNull();
    });

    it("rejects a malformed shape", () => {
        expect(decodeClaims("aaa.bbb")).toBeNull();
    });
});

describe("acceptToken", () => {
    const now = Date.now();

    it("accepts a usable token and derives the API base", () => {
        expect(acceptToken(token(goodClaims), "global", now)).toEqual({
            accessToken: token(goodClaims),
            apiBase: "https://api.plaud.ai",
        });
    });

    it("accepts a token without an expiry", () => {
        const value = token({ sub: "person@example.com" });
        expect(acceptToken(value, "global", now)).not.toBeNull();
    });

    it("rejects a token that expired in the past", () => {
        const value = token({ exp: Math.floor(now / 1000) - 10 });
        expect(acceptToken(value, "global", now)).toBeNull();
    });

    it("rejects a token that expires within 60 seconds", () => {
        const value = token({ exp: Math.floor(now / 1000) + 30 });
        expect(acceptToken(value, "global", now)).toBeNull();
    });

    it("accepts a token that expires after 60 seconds", () => {
        const value = token({ exp: Math.floor(now / 1000) + 120 });
        expect(acceptToken(value, "global", now)).not.toBeNull();
    });

    it("rejects a workspace token by ut_ref", () => {
        expect(acceptToken(token({ ...goodClaims, ut_ref: "ref" }), "global", now)).toBeNull();
    });

    it("rejects a workspace token by wid", () => {
        expect(acceptToken(token({ ...goodClaims, wid: "ws-1" }), "global", now)).toBeNull();
    });

    it("rejects a token with a non-numeric expiry", () => {
        expect(acceptToken(token({ exp: "soon" }), "global", now)).toBeNull();
    });
});

describe("apiBaseForClaims", () => {
    const cases: [string | undefined, "global" | "cn", string][] = [
        ["aws:us-west-2", "global", "https://api.plaud.ai"],
        ["aws:eu-central-1", "global", "https://api-euc1.plaud.ai"],
        ["aws:ap-southeast-1", "global", "https://api-apse1.plaud.ai"],
        ["something-else", "global", "https://api.plaud.ai"],
        [undefined, "cn", "https://api.plaud.cn"],
        [undefined, "global", "https://api.plaud.ai"],
    ];
    for (const [region, site, expected] of cases) {
        it(`${region ?? "no region"} on ${site} gives ${expected}`, () => {
            expect(apiBaseForClaims({ region }, site)).toBe(expected);
        });
    }
});
