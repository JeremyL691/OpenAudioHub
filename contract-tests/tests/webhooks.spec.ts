import { createHmac } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type APIRequestContext, expect, test } from "@playwright/test";
import { newUserContext, uploadRecording } from "../helpers/api";
import { addProvider, fakeProvider, FAKE_CHAT, transcribeAndWait } from "../helpers/transcription-extra";

// ---------- helpers local to this file ----------

const EVENT_NAMES = [
    "recording.synced",
    "recording.updated",
    "recording.deleted",
    "transcription.completed",
    "transcription.failed",
    "summary.completed",
    "summary.failed",
];

interface Webhook {
    id: string;
    url: string;
    secret: string;
    events: string[];
    description: string | null;
    enabled: boolean;
    lastDeliveryAt: string | null;
    lastDeliveryStatus: string | null;
    createdAt: string;
    updatedAt: string;
}

interface Delivery {
    id: string;
    event: string;
    status: string;
    attempts: number;
    lastResponseStatus: number | null;
    lastResponseBody: string | null;
    lastError: string | null;
}

interface Received {
    headers: IncomingHttpHeaders;
    rawBody: string;
}

async function createWebhook(
    api: APIRequestContext,
    data: Record<string, unknown>,
): Promise<{ webhook: Webhook; secret: string }> {
    const res = await api.post("/api/settings/webhooks", { data });
    expect(res.status(), "create webhook").toBe(201);
    return (await res.json()) as { webhook: Webhook; secret: string };
}

async function listWebhooks(api: APIRequestContext): Promise<Webhook[]> {
    const res = await api.get("/api/settings/webhooks");
    expect(res.status(), "list webhooks").toBe(200);
    return ((await res.json()) as { webhooks: Webhook[] }).webhooks;
}

async function listDeliveries(
    api: APIRequestContext,
    id: string,
): Promise<Delivery[]> {
    const res = await api.get(`/api/settings/webhooks/${id}/deliveries`);
    expect(res.status(), "list deliveries").toBe(200);
    return ((await res.json()) as { deliveries: Delivery[] }).deliveries;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls `read` every 200 ms until it returns a value, or fails after `timeoutMs`. */
async function pollUntil<T>(
    read: () => Promise<T | undefined> | T | undefined,
    timeoutMs = 15_000,
): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await read();
        if (value !== undefined) return value;
        if (Date.now() > deadline) {
            throw new Error(`condition not met within ${timeoutMs} ms`);
        }
        await sleep(200);
    }
}

// ---------- create, list, update, delete ----------

test.describe("webhooks: endpoints", () => {
    test("create returns the full secret once, and the list masks it", async () => {
        const api = await newUserContext("webhook-create");
        const url = "https://hooks.example.com/openaudiohub";
        const { webhook, secret } = await createWebhook(api, {
            url,
            events: ["recording.deleted", "summary.completed"],
            description: "  contract hook  ",
        });

        expect(webhook.url).toBe(url);
        expect(webhook.events).toEqual([
            "recording.deleted",
            "summary.completed",
        ]);
        expect(webhook.description).toBe("contract hook");
        expect(webhook.enabled).toBe(true);
        expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{32}$/);
        expect(webhook.secret).toBe(`whsec_****${secret.slice(-4)}`);

        const listed = await listWebhooks(api);
        const row = listed.find((w) => w.id === webhook.id);
        expect(row, "created webhook is listed").toBeTruthy();
        expect(row!.secret).toBe(`whsec_****${secret.slice(-4)}`);
        // The full secret is never returned by the list, and not in any field of it.
        expect(JSON.stringify(listed)).not.toContain(secret);

        await api.dispose();
    });

    test("list reports the event names this server delivers", async () => {
        const api = await newUserContext("webhook-events");
        const res = await api.get("/api/settings/webhooks");
        expect(res.status()).toBe(200);
        const body = (await res.json()) as { webhooks: unknown[]; events: string[] };
        expect(body.webhooks).toEqual([]);
        expect([...body.events].sort()).toEqual([...EVENT_NAMES].sort());
        await api.dispose();
    });

    test("invalid URLs are refused with INVALID_INPUT on the url field", async () => {
        const api = await newUserContext("webhook-badurl");
        const badUrls = [
            "not a url",
            "ftp://hooks.example.com/openaudiohub",
            "https://user:pass@hooks.example.com/openaudiohub",
        ];
        for (const url of badUrls) {
            const res = await api.post("/api/settings/webhooks", {
                data: { url, events: ["recording.deleted"] },
            });
            expect(res.status(), url).toBe(400);
            const body = (await res.json()) as {
                code: string;
                details: { field: string };
            };
            expect(body.code, url).toBe("INVALID_INPUT");
            expect(body.details.field, url).toBe("url");
        }
        const missing = await api.post("/api/settings/webhooks", {
            data: { events: ["recording.deleted"] },
        });
        expect(missing.status()).toBe(400);
        expect((await missing.json()).details.field).toBe("url");
        expect(await listWebhooks(api)).toEqual([]);
        await api.dispose();
    });

    test("unknown and empty event lists are refused with INVALID_INPUT on the events field", async () => {
        const api = await newUserContext("webhook-badevent");
        const url = "https://hooks.example.com/openaudiohub";

        const unknown = await api.post("/api/settings/webhooks", {
            data: { url, events: ["recording.exploded"] },
        });
        expect(unknown.status()).toBe(400);
        const body = (await unknown.json()) as {
            error: string;
            code: string;
            details: { field: string };
        };
        expect(body.code).toBe("INVALID_INPUT");
        expect(body.details.field).toBe("events");
        expect(body.error).toContain("recording.exploded");

        for (const events of [[], undefined]) {
            const res = await api.post("/api/settings/webhooks", {
                data: { url, events },
            });
            expect(res.status(), JSON.stringify(events)).toBe(400);
            expect((await res.json()).details.field).toBe("events");
        }
        expect(await listWebhooks(api)).toEqual([]);
        await api.dispose();
    });

    test("update changes events and enabled, and refuses bad values", async () => {
        const api = await newUserContext("webhook-update");
        const { webhook } = await createWebhook(api, {
            url: "https://hooks.example.com/openaudiohub",
            events: ["recording.deleted"],
        });

        const disable = await api.patch(`/api/settings/webhooks/${webhook.id}`, {
            data: {
                enabled: false,
                events: ["summary.completed", "recording.updated"],
            },
        });
        expect(disable.status()).toBe(200);
        const updated = (await disable.json()) as { webhook: Webhook };
        expect(updated.webhook.enabled).toBe(false);
        expect(updated.webhook.events).toEqual([
            "summary.completed",
            "recording.updated",
        ]);

        const listed = (await listWebhooks(api)).find((w) => w.id === webhook.id);
        expect(listed?.enabled).toBe(false);
        expect(listed?.events).toEqual(["summary.completed", "recording.updated"]);

        const enable = await api.patch(`/api/settings/webhooks/${webhook.id}`, {
            data: { enabled: true },
        });
        expect(enable.status()).toBe(200);
        expect(((await enable.json()) as { webhook: Webhook }).webhook.enabled).toBe(true);

        const emptyEvents = await api.patch(`/api/settings/webhooks/${webhook.id}`, {
            data: { events: [] },
        });
        expect(emptyEvents.status()).toBe(400);
        expect((await emptyEvents.json()).details.field).toBe("events");

        const badEnabled = await api.patch(`/api/settings/webhooks/${webhook.id}`, {
            data: { enabled: "yes" },
        });
        expect(badEnabled.status()).toBe(400);
        expect((await badEnabled.json()).details.field).toBe("enabled");

        const badUrl = await api.patch(`/api/settings/webhooks/${webhook.id}`, {
            data: { url: "not a url" },
        });
        expect(badUrl.status()).toBe(400);
        expect((await badUrl.json()).details.field).toBe("url");

        await api.dispose();
    });

    test("delete removes the endpoint, and a second delete is 404", async () => {
        const api = await newUserContext("webhook-delete");
        const { webhook } = await createWebhook(api, {
            url: "https://hooks.example.com/openaudiohub",
            events: ["recording.deleted"],
        });

        const res = await api.delete(`/api/settings/webhooks/${webhook.id}`);
        expect(res.status()).toBe(200);
        expect(await res.json()).toEqual({ success: true });

        const listed = await listWebhooks(api);
        expect(listed.map((w) => w.id)).not.toContain(webhook.id);

        const again = await api.delete(`/api/settings/webhooks/${webhook.id}`);
        expect(again.status()).toBe(404);
        expect((await again.json()).code).toBe("NOT_FOUND");

        await api.dispose();
    });

    test("another account cannot see, update, or delete an endpoint (404)", async () => {
        const owner = await newUserContext("webhook-owner");
        const other = await newUserContext("webhook-other");
        const { webhook } = await createWebhook(owner, {
            url: "https://hooks.example.com/openaudiohub",
            events: ["recording.deleted"],
        });

        expect((await listWebhooks(other)).map((w) => w.id)).not.toContain(webhook.id);

        const deliveries = await other.get(
            `/api/settings/webhooks/${webhook.id}/deliveries`,
        );
        expect(deliveries.status()).toBe(404);

        const patch = await other.patch(`/api/settings/webhooks/${webhook.id}`, {
            data: { enabled: false },
        });
        expect(patch.status()).toBe(404);
        expect((await patch.json()).code).toBe("NOT_FOUND");

        const remove = await other.delete(`/api/settings/webhooks/${webhook.id}`);
        expect(remove.status()).toBe(404);

        // The owner's endpoint is untouched by the attempts above.
        const still = (await listWebhooks(owner)).find((w) => w.id === webhook.id);
        expect(still?.enabled).toBe(true);

        await owner.dispose();
        await other.dispose();
    });
});

// ---------- a real delivery to a local receiver ----------

test.describe("webhooks: delivery", () => {
    let server: Server;
    let receiverUrl: string;
    const received: Received[] = [];

    test.beforeAll(async () => {
        server = createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (chunk: Buffer) => chunks.push(chunk));
            req.on("end", () => {
                received.push({
                    headers: req.headers,
                    rawBody: Buffer.concat(chunks).toString("utf8"),
                });
                res.writeHead(200, { "content-type": "text/plain" });
                res.end("ok");
            });
        });
        await new Promise<void>((resolve) =>
            server.listen(0, "127.0.0.1", () => resolve()),
        );
        const { port } = server.address() as AddressInfo;
        receiverUrl = `http://127.0.0.1:${port}/hook`;
    });

    test.afterAll(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    test("deleting a recording posts a signed recording.deleted event and records success", async () => {
        const api = await newUserContext("webhook-deliver");
        const { webhook, secret } = await createWebhook(api, {
            url: receiverUrl,
            events: ["recording.deleted"],
        });

        // Deleting a recording emits recording.deleted for the owner's enabled endpoints.
        const recordingId = await uploadRecording(api);
        const del = await api.delete(`/api/recordings/${recordingId}`);
        expect(del.status()).toBe(200);

        const hit = await pollUntil(() =>
            received.find((r) => {
                try {
                    return JSON.parse(r.rawBody).data?.id === recordingId;
                } catch {
                    return false;
                }
            }),
        );

        const event = hit.headers["x-openaudiohub-event"];
        const deliveryId = hit.headers["x-openaudiohub-delivery"];
        const timestamp = hit.headers["x-openaudiohub-timestamp"];
        const signature = hit.headers["x-openaudiohub-signature"];
        expect(event).toBe("recording.deleted");
        expect(deliveryId).toEqual(expect.any(String));
        expect(timestamp).toMatch(/^\d+$/);

        const expectedSignature = createHmac("sha256", secret)
            .update(`${timestamp}.${hit.rawBody}`)
            .digest("hex");
        expect(signature).toBe(expectedSignature);

        const body = JSON.parse(hit.rawBody) as {
            event: string;
            delivered_at: string;
            data: { id: string; deleted_at?: string };
        };
        expect(body.event).toBe("recording.deleted");
        expect(body.delivered_at).toEqual(expect.any(String));
        expect(body.data.id).toBe(recordingId);
        expect(body.data.deleted_at).toEqual(expect.any(String));

        const delivery = await pollUntil(async () => {
            const rows = await listDeliveries(api, webhook.id);
            const row = rows.find((d) => d.id === deliveryId);
            return row && row.status === "success" ? row : undefined;
        });
        expect(delivery.event).toBe("recording.deleted");
        expect(delivery.attempts).toBe(1);
        expect(delivery.lastResponseStatus).toBe(200);
        expect(delivery.lastError).toBeNull();
        // Response bodies are kept only when WEBHOOKS_REQUIRE_PUBLIC_TARGETS is true, which the
        // test server does not set.
        expect(delivery.lastResponseBody).toBeNull();

        const endpoint = (await listWebhooks(api)).find((w) => w.id === webhook.id);
        expect(endpoint?.lastDeliveryStatus).toBe("success");

        await api.dispose();
    });

    test("a summary webhook carries action_items and key_points as JSON arrays", async () => {
        const api = await newUserContext("webhook-summary");
        const { webhook, secret } = await createWebhook(api, {
            url: receiverUrl,
            events: ["summary.completed"],
        });
        // Automatic summaries run after a transcript is saved, so the account turns them on
        // before transcribing. summary.completed is emitted only on that path.
        expect((await api.put("/api/settings/user", { data: { autoSummarize: true } })).ok()).toBeTruthy();
        await addProvider(api, fakeProvider());
        const recordingId = await uploadRecording(api);
        expect(await transcribeAndWait(api, recordingId)).toBeLessThan(300);

        const hit = await pollUntil(() =>
            received.find((r) => {
                if (r.headers["x-openaudiohub-event"] !== "summary.completed") return false;
                try {
                    return JSON.parse(r.rawBody).data?.id === recordingId;
                } catch {
                    return false;
                }
            }),
        );
        const timestamp = hit.headers["x-openaudiohub-timestamp"];
        expect(hit.headers["x-openaudiohub-signature"]).toBe(
            createHmac("sha256", secret).update(`${timestamp}.${hit.rawBody}`).digest("hex"),
        );

        const body = JSON.parse(hit.rawBody) as {
            event: string;
            data: { summary: { text: string; action_items: unknown; key_points: unknown } | null };
        };
        expect(body.event).toBe("summary.completed");
        expect(body.data.summary).not.toBeNull();
        expect(body.data.summary!.text).toBe(FAKE_CHAT);
        expect(Array.isArray(body.data.summary!.action_items)).toBe(true);
        expect(Array.isArray(body.data.summary!.key_points)).toBe(true);
        expect(body.data.summary!.action_items).toEqual(["Follow up"]);
        expect(body.data.summary!.key_points).toEqual(["First point", "Second point"]);

        await pollUntil(async () => {
            const row = (await listDeliveries(api, webhook.id)).find((d) => d.event === "summary.completed");
            return row && row.status === "success" ? row : undefined;
        });
        await api.dispose();
    });
});
