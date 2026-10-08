import { formatWebhookSignatureHeader } from "@/lib/webhooks/signature";

/**
 * Headers sent with every webhook delivery. The names are part of the public
 * contract (D-007): they changed with the rename and are not aliased.
 */
export function buildWebhookHeaders(input: {
    body: string;
    event: string;
    deliveryId: string;
    timestamp: number;
    secret: string;
}): Record<string, string> {
    return {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(input.body).toString(),
        "User-Agent": "OpenAudioHub-Webhooks/1",
        "X-OpenAudioHub-Event": input.event,
        "X-OpenAudioHub-Delivery": input.deliveryId,
        "X-OpenAudioHub-Timestamp": String(input.timestamp),
        "X-OpenAudioHub-Signature": formatWebhookSignatureHeader(
            input.secret,
            input.timestamp,
            input.body,
        ),
    };
}
