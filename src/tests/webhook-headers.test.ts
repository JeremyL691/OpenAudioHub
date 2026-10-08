import { describe, expect, it } from "vitest";
import { buildWebhookHeaders } from "@/lib/webhooks/headers";

describe("webhook delivery headers", () => {
    const headers = buildWebhookHeaders({
        body: '{"event":"recording.created"}',
        event: "recording.created",
        deliveryId: "del_1",
        timestamp: 1_700_000_000,
        secret: "whsec_test",
    });

    it("identifies the sender and the event with the OpenAudioHub names", () => {
        expect(headers["User-Agent"]).toBe("OpenAudioHub-Webhooks/1");
        expect(headers["X-OpenAudioHub-Event"]).toBe("recording.created");
        expect(headers["X-OpenAudioHub-Delivery"]).toBe("del_1");
        expect(headers["X-OpenAudioHub-Timestamp"]).toBe("1700000000");
        expect(headers["X-OpenAudioHub-Signature"]).toMatch(/\S/);
    });

    it("no longer sends the pre-rename header names", () => {
        expect(Object.keys(headers).some((name) => /riffado/i.test(name))).toBe(
            false,
        );
    });

    it("sets the body length and JSON content type", () => {
        expect(headers["Content-Type"]).toBe("application/json");
        expect(headers["Content-Length"]).toBe(
            String(Buffer.byteLength('{"event":"recording.created"}')),
        );
    });
});
