import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Bark is a push service the user configures. The send path is tested with a stubbed fetch.
vi.mock("@/lib/env", () => ({ env: {} }));

import { sendBarkNotification } from "@/lib/notifications/bark";

const PUSH_URL = "https://push.example.test/device-key";

describe("sendBarkNotification", () => {
    beforeEach(() => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it("posts only the fields that are set, with the flags Bark expects", async () => {
        const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
        vi.stubGlobal("fetch", fetchMock);

        const sent = await sendBarkNotification(PUSH_URL, {
            body: "Transcript ready",
            title: "OpenAudioHub",
            group: "openaudiohub-recordings",
            autoCopy: true,
            isArchive: false,
        });

        expect(sent).toBe(true);
        const [url, init] = fetchMock.mock.calls[0] as unknown as [
            string,
            RequestInit,
        ];
        expect(url).toBe(PUSH_URL);
        expect(init.method).toBe("POST");
        expect(JSON.parse(String(init.body))).toEqual({
            body: "Transcript ready",
            title: "OpenAudioHub",
            group: "openaudiohub-recordings",
            autoCopy: "1",
            isArchive: 0,
        });
    });

    it("returns false when the push service answers with an error", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response("bad key", { status: 500 })),
        );

        await expect(
            sendBarkNotification(PUSH_URL, { body: "x" }),
        ).resolves.toBe(false);
    });

    it("returns false, without throwing, when the request cannot be sent", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                throw new TypeError("fetch failed");
            }),
        );

        await expect(
            sendBarkNotification(PUSH_URL, { body: "x" }),
        ).resolves.toBe(false);
    });
});
