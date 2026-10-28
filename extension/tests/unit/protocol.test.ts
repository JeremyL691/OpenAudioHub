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
        expect(tokenMessage("abc.def.ghi", "https://api-euc1.plaud.ai")).toEqual({
            app: PAGE_APP,
            protocol: PROTOCOL,
            kind: "token",
            accessToken: "abc.def.ghi",
            apiBase: "https://api-euc1.plaud.ai",
        });
    });

    it("adds the refresh key to a token message when given", () => {
        expect(tokenMessage("abc.def.ghi", "https://api.plaud.ai", "k".repeat(43))).toEqual({
            app: PAGE_APP,
            protocol: PROTOCOL,
            kind: "token",
            accessToken: "abc.def.ghi",
            apiBase: "https://api.plaud.ai",
            refreshKey: "k".repeat(43),
        });
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
