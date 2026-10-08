// Deterministic OpenAI-compatible stub for E2E and the long-audio smoke run (PLAN T0.7).
// Serves GET /v1/models, POST /v1/audio/transcriptions (verbose_json), and
// POST /v1/chat/completions. Responses do not depend on the request body.
// Listens on 127.0.0.1 only; nothing here calls out to the network.
import { SHORT_SEGMENTS, SUMMARY } from "./e2e-fixtures";

const PORT = Number(process.env.FAKE_AI_PORT ?? 3299);

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}

Bun.serve({
    port: PORT,
    hostname: "127.0.0.1",
    async fetch(request) {
        const { pathname } = new URL(request.url);

        if (request.method === "GET" && pathname === "/v1/models") {
            return json({
                object: "list",
                data: [
                    { id: "fake-whisper-1", object: "model" },
                    { id: "fake-chat-1", object: "model" },
                ],
            });
        }

        if (
            request.method === "POST" &&
            pathname === "/v1/audio/transcriptions"
        ) {
            await request.arrayBuffer();
            const last = SHORT_SEGMENTS[SHORT_SEGMENTS.length - 1];
            return json({
                task: "transcribe",
                language: "en",
                duration: last.end,
                text: SHORT_SEGMENTS.map((segment) => segment.text).join(" "),
                segments: SHORT_SEGMENTS.map((segment, id) => ({
                    id,
                    seek: 0,
                    start: segment.start,
                    end: segment.end,
                    text: ` ${segment.text}`,
                    tokens: [],
                    temperature: 0,
                    avg_logprob: -0.1,
                    compression_ratio: 1,
                    no_speech_prob: 0,
                })),
            });
        }

        if (request.method === "POST" && pathname === "/v1/chat/completions") {
            await request.arrayBuffer();
            return json({
                id: "fake-chat-completion",
                object: "chat.completion",
                created: 0,
                model: "fake-chat-1",
                choices: [
                    {
                        index: 0,
                        message: {
                            role: "assistant",
                            content: JSON.stringify(SUMMARY),
                        },
                        finish_reason: "stop",
                    },
                ],
                usage: {
                    prompt_tokens: 0,
                    completion_tokens: 0,
                    total_tokens: 0,
                },
            });
        }

        return json({ error: { message: "not found" } }, 404);
    },
});

console.log(`fake AI server listening on 127.0.0.1:${PORT}`);
