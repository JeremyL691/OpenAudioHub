import { describe, expect, it } from "vitest";
import {
    isAppUrl,
    isOpenableExternally,
    isPermissionGranted,
    needsSessionExchange,
    safeDownloadName,
} from "../src/main/guards.js";
import { exchangeSession, SessionExchangeError } from "../src/main/session.js";

const ORIGIN = "http://127.0.0.1:38400";

describe("navigation guards", () => {
    it("treats only the app origin as inside the app", () => {
        expect(isAppUrl("http://127.0.0.1:38400/dashboard", ORIGIN)).toBe(true);
        expect(isAppUrl("http://127.0.0.1:38401/dashboard", ORIGIN)).toBe(
            false,
        );
        expect(isAppUrl("http://localhost:38400/dashboard", ORIGIN)).toBe(
            false,
        );
        expect(isAppUrl("https://example.com/", ORIGIN)).toBe(false);
    });

    it("re-exchanges the session for sign-in and landing pages only", () => {
        expect(needsSessionExchange(`${ORIGIN}/login`, ORIGIN)).toBe(true);
        expect(needsSessionExchange(`${ORIGIN}/login/`, ORIGIN)).toBe(true);
        expect(needsSessionExchange(`${ORIGIN}/register`, ORIGIN)).toBe(true);
        expect(needsSessionExchange(`${ORIGIN}/`, ORIGIN)).toBe(true);
        expect(needsSessionExchange(`${ORIGIN}/dashboard`, ORIGIN)).toBe(false);
        expect(
            needsSessionExchange(`${ORIGIN}/recordings?id=abc`, ORIGIN),
        ).toBe(false);
        expect(needsSessionExchange("https://example.com/login", ORIGIN)).toBe(
            false,
        );
    });

    it("opens only http and https links outside the app", () => {
        expect(
            isOpenableExternally("https://github.com/JeremyL691/OpenAudioHub"),
        ).toBe(true);
        expect(isOpenableExternally("http://example.com")).toBe(true);
        expect(isOpenableExternally("file:///etc/passwd")).toBe(false);
        expect(isOpenableExternally("javascript:alert(1)")).toBe(false);
        expect(isOpenableExternally("not a url")).toBe(false);
    });

    it("grants notifications and nothing else", () => {
        expect(isPermissionGranted("notifications")).toBe(true);
        expect(isPermissionGranted("media")).toBe(false);
        expect(isPermissionGranted("geolocation")).toBe(false);
        expect(isPermissionGranted("clipboard-read")).toBe(false);
    });

    it("cleans download names", () => {
        expect(safeDownloadName("../../etc/passwd")).toBe("passwd");
        expect(safeDownloadName("..hidden.txt")).toBe("hidden.txt");
        expect(safeDownloadName("a\u0000b\u001fc.mp3")).toBe("abc.mp3");
        expect(safeDownloadName("   ")).toBe("download");
        expect(safeDownloadName("x".repeat(300)).length).toBe(200);
    });
});

describe("exchangeSession", () => {
    const noSleep = async () => undefined;

    it("sends the bearer secret to the loopback origin and resolves on 204", async () => {
        const calls: Array<{
            url: string;
            init: { method: string; headers: Record<string, string> };
        }> = [];
        await exchangeSession({
            appOrigin: ORIGIN,
            launchSecret: "secret-value",
            fetch: async (url, init) => {
                calls.push({ url, init });
                return { status: 204 };
            },
            sleep: noSleep,
        });

        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe(`${ORIGIN}/api/desktop/session`);
        expect(calls[0].init).toEqual({
            method: "POST",
            headers: { Authorization: "Bearer secret-value" },
        });
    });

    it("retries transient failures and then succeeds", async () => {
        let attempts = 0;
        await exchangeSession({
            appOrigin: ORIGIN,
            launchSecret: "s",
            fetch: async () => {
                attempts += 1;
                if (attempts < 3) throw new Error("connection refused");
                return { status: 204 };
            },
            sleep: noSleep,
        });

        expect(attempts).toBe(3);
    });

    it("does not retry a rejected secret", async () => {
        let attempts = 0;
        await expect(
            exchangeSession({
                appOrigin: ORIGIN,
                launchSecret: "wrong",
                fetch: async () => {
                    attempts += 1;
                    return { status: 401 };
                },
                sleep: noSleep,
            }),
        ).rejects.toBeInstanceOf(SessionExchangeError);
        expect(attempts).toBe(1);
    });
});
