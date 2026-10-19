// Minimal OpenAI-compatible (plus ElevenLabs speech-to-text) server for the
// contract suite. Answers are fixed so tests can assert on them.
// Usage: node fakes/fake-ai.mjs [port]
//
// Test hooks:
//   GET /__requests          the last 50 requests received (newest last), each with a growing `seq`
//   GET /__requests?path=X   only those whose path ends with X
//   POST /__answer           { content } overrides the chat answer; null restores the fixed one
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? process.env.FAKE_AI_PORT ?? 3299);

export const TRANSCRIPT_TEXT =
    "Hello from the contract suite. This is a fixed transcript.";
export const CHAT_TEXT = "Contract summary: a short fixed answer.";

const segments = [
    { id: 0, start: 0, end: 1.5, text: "Hello from the contract suite.", speaker: "A" },
    { id: 1, start: 1.5, end: 3, text: "This is a fixed transcript.", speaker: "B" },
];

const requests = [];
let seq = 0;
/** Chat answer override: a string replaces the fixed reply, null restores it. */
let answerOverride = null;

function send(res, status, body) {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
}

/** Text of the chat messages only; audio and image parts are ignored. */
function messageText(messages) {
    const parts = [];
    for (const m of messages ?? []) {
        if (typeof m.content === "string") parts.push(m.content);
        else if (Array.isArray(m.content))
            for (const p of m.content) if (p?.type === "text") parts.push(p.text ?? "");
    }
    return parts.join("\n");
}

/** Multipart form fields (not file contents), parsed loosely. */
function formFields(raw, contentType) {
    const boundary = /boundary=(.+)$/.exec(contentType ?? "")?.[1];
    if (!boundary) return {};
    const fields = {};
    for (const part of raw.toString("latin1").split(`--${boundary}`)) {
        const name = /name="([^"]+)"/.exec(part)?.[1];
        if (!name || /filename="/.test(part)) continue;
        const value = part.split("\r\n\r\n").slice(1).join("\r\n\r\n").replace(/\r\n$/, "");
        fields[name] = Buffer.from(value, "latin1").toString("utf8");
    }
    return fields;
}

function transcription(fields) {
    const base = { text: TRANSCRIPT_TEXT, language: "en", duration: 3 };
    if (fields.response_format === "text") return TRANSCRIPT_TEXT;
    if (fields.response_format === "diarized_json")
        return { ...base, segments: segments.map((s) => ({ ...s, type: "transcript.text.segment" })) };
    return { ...base, segments: segments.map(({ speaker, ...s }) => s) };
}

createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
        const raw = Buffer.concat(chunks);
        const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
        const path = url.pathname.replace(/^\/v1/, "");

        if (req.method === "GET" && path === "/__requests") {
            const filter = url.searchParams.get("path");
            return send(res, 200, requests.filter((r) => !filter || r.path.endsWith(filter)));
        }
        if (req.method === "POST" && path === "/__answer") {
            const body = raw.length ? JSON.parse(raw.toString("utf8")) : {};
            answerOverride = typeof body.content === "string" ? body.content : null;
            return send(res, 200, { ok: true, override: answerOverride });
        }

        let json = null;
        if ((req.headers["content-type"] ?? "").includes("application/json")) {
            try {
                json = JSON.parse(raw.toString("utf8"));
            } catch {}
        }
        const fields = formFields(raw, req.headers["content-type"]);
        requests.push({
            seq: ++seq,
            method: req.method,
            path,
            headers: { authorization: req.headers.authorization ? "present" : "absent", "xi-api-key": req.headers["xi-api-key"] ? "present" : "absent" },
            fields,
            json: json && { ...json, messages: json.messages ? messageText(json.messages) : undefined },
        });
        if (requests.length > 50) requests.shift();

        if (req.method === "GET" && path === "/models") {
            return send(res, 200, {
                object: "list",
                data: [
                    { id: "fake-whisper-1", object: "model" },
                    { id: "fake-chat-1", object: "model" },
                ],
            });
        }
        if (req.method === "POST" && path === "/audio/transcriptions") {
            const body = transcription(fields);
            if (typeof body === "string") {
                res.writeHead(200, { "content-type": "text/plain" });
                return res.end(body);
            }
            return send(res, 200, body);
        }
        if (req.method === "POST" && path === "/speech-to-text") {
            // ElevenLabs shape: words with timings and speaker ids.
            const words = segments.flatMap((s) =>
                s.text.split(" ").map((w, i, all) => ({
                    text: w,
                    type: "word",
                    start: s.start + ((s.end - s.start) * i) / all.length,
                    end: s.start + ((s.end - s.start) * (i + 1)) / all.length,
                    speaker_id: `speaker_${s.speaker === "A" ? 0 : 1}`,
                })),
            );
            return send(res, 200, { language_code: "en", text: TRANSCRIPT_TEXT, words });
        }
        if (req.method === "POST" && path === "/chat/completions") {
            const text = json ? messageText(json.messages) : "";
            const wantsJson = Boolean(json?.response_format) || /\bjson\b/i.test(text);
            const content = answerOverride ?? (wantsJson
                ? JSON.stringify({
                      title: "Contract Title",
                      summary: CHAT_TEXT,
                      keyPoints: ["First point", "Second point"],
                      actionItems: ["Follow up"],
                  })
                : CHAT_TEXT);
            return send(res, 200, {
                id: "chatcmpl-contract",
                object: "chat.completion",
                created: 0,
                model: json?.model ?? "fake-chat-1",
                choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            });
        }
        send(res, 404, { error: { message: `no fake for ${req.method} ${path}` } });
    });
}).listen(port, "127.0.0.1", () => {
    console.log(`fake AI listening on http://127.0.0.1:${port}/v1`);
});
