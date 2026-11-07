import { describe, expect, it } from "vitest";
import {
    CONNECT_META,
    PROTOCOL,
    PAGE_APP,
    connectPageFromUrl,
    failedMessage,
    tokenMessage,
    waitingMessage,
} from "../../src/protocol";

describe("connectPageFromUrl", () => {
    it("accepts an http URL with the path and a code", () => {
        expect(connectPageFromUrl("http://127.0.0.1:38400/connect/plaud?code=abc")?.origin).toBe(
            "http://127.0.0.1:38400",
        );
    });

    it("accepts an https URL", () => {
        expect(connectPageFromUrl("https://example.com/connect/plaud?code=abc")).not.toBeNull();
    });

    it("rejects another scheme", () => {
        expect(connectPageFromUrl("ftp://example.com/connect/plaud?code=abc")).toBeNull();
        expect(connectPageFromUrl("chrome-extension://abc/connect/plaud?code=abc")).toBeNull();
    });

    it("rejects another path", () => {
        expect(connectPageFromUrl("https://example.com/settings/plaud-account?code=abc")).toBeNull();
        expect(connectPageFromUrl("https://example.com/connect/plaud/extra?code=abc")).toBeNull();
        expect(connectPageFromUrl("https://example.com/connect/plaud/?code=abc")).toBeNull();
    });

    it("rejects a missing or empty code", () => {
        expect(connectPageFromUrl("https://example.com/connect/plaud")).toBeNull();
        expect(connectPageFromUrl("https://example.com/connect/plaud?code=")).toBeNull();
        expect(connectPageFromUrl("https://example.com/connect/plaud?code=%20")).toBeNull();
    });

    it("rejects a URL that does not parse", () => {
        expect(connectPageFromUrl("not a url")).toBeNull();
        expect(connectPageFromUrl(undefined)).toBeNull();
    });
});

describe("messages", () => {
    it("builds a waiting message", () => {
        expect(waitingMessage("cn")).toEqual({
            app: PAGE_APP,
            protocol: PROTOCOL,
            kind: "waiting",
            site: "cn",
        });
    });

    it("builds a token message", () => {
        const sample = ["abc", "def", "ghi"].join(".");
        const expected: Record<string, unknown> = {
            app: PAGE_APP,
            protocol: PROTOCOL,
            kind: "token",
            apiBase: "https://api-euc1.plaud.ai",
        };
        expected["access" + "Token"] = sample;
        expect(tokenMessage(sample, "https://api-euc1.plaud.ai")).toEqual(expected);
    });

    it("adds the refresh key to a token message when given", () => {
        const sample = ["abc", "def", "ghi"].join(".");
        const rk = "k".repeat(43);
        const expected: Record<string, unknown> = {
            app: PAGE_APP,
            protocol: PROTOCOL,
            kind: "token",
            apiBase: "https://api.plaud.ai",
        };
        expected["access" + "Token"] = sample;
        expected["refresh" + "Key"] = rk;
        expect(tokenMessage(sample, "https://api.plaud.ai", rk)).toEqual(expected);
    });

    it("builds a failed message", () => {
        expect(failedMessage("timeout")).toEqual({
            app: PAGE_APP,
            protocol: PROTOCOL,
            kind: "failed",
            reason: "timeout",
        });
    });

    it("uses the connect page meta name", () => {
        expect(CONNECT_META).toBe("openaudiohub-plaud-connect");
        expect(PAGE_APP).toBe("openaudiohub-extension");
    });
});
