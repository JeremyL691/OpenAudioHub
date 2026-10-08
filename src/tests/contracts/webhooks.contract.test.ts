import { describe, expect, it, vi } from "vitest";
import { WEBHOOK_EVENTS } from "@/lib/webhooks/emit";
import {
    createOutboundWebhookPayload,
    createRedactedWebhookPayload,
} from "@/lib/webhooks/payload";
import {
    createWebhookSignature,
    formatWebhookSignatureHeader,
    verifyWebhookSignature,
} from "@/lib/webhooks/signature";

// Contract snapshots for outbound webhooks (PLAN T0.8). Header names are checked
// by the delivery worker tests; this file pins the event list, payload body, and
// signature format. T2.6 renames the headers and updates these snapshots on purpose.
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/env", () => ({ env: {} }));

const DELIVERED_AT = new Date("2026-01-01T00:00:00Z");
const SECRET = "whsec_contract_fixture";
const BODY = '{"event":"recording.created","data":{"id":"rec-1"}}';
const TIMESTAMP = 1_767_225_600;

describe("webhook contract", () => {
    it("lists the supported events in a fixed order", () => {
        expect([...WEBHOOK_EVENTS]).toMatchSnapshot();
    });

    it("builds the outbound payload body", () => {
        expect(
            createOutboundWebhookPayload(
                "recording.created",
                DELIVERED_AT,
                { id: "rec-1", title: "Weekly sync" },
                null,
            ),
        ).toMatchSnapshot();
    });

    it("adds an error object only when delivery failed", () => {
        expect(
            createOutboundWebhookPayload(
                "transcript.completed",
                DELIVERED_AT,
                null,
                "receiver returned HTTP 500",
            ),
        ).toMatchSnapshot();
    });

    it("builds the redacted payload used when a stored body is unavailable", () => {
        expect(
            createRedactedWebhookPayload("rec-1", DELIVERED_AT),
        ).toMatchSnapshot();
    });

    it("formats the signature header and verifies it round-trip", () => {
        const header = formatWebhookSignatureHeader(SECRET, TIMESTAMP, BODY);
        expect(header).toMatchSnapshot();
        expect(
            verifyWebhookSignature(SECRET, header, BODY, 300, TIMESTAMP),
        ).toBe(true);
        expect(
            verifyWebhookSignature(SECRET, header, `${BODY} `, 300, TIMESTAMP),
        ).toBe(false);
    });

    it("signs timestamp and body with HMAC-SHA256 hex", () => {
        expect(
            createWebhookSignature(SECRET, TIMESTAMP, BODY),
        ).toMatchSnapshot();
    });
});
