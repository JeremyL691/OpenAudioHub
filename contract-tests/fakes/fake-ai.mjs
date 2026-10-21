// Minimal OpenAI-compatible (plus ElevenLabs speech-to-text) server for the
// contract suite. Answers are fixed so tests can assert on them.
// Usage: node fakes/fake-ai.mjs [port]
//
// Test hooks:
//   GET /__requests          the last 50 requests received (newest last), each with a growing `seq`
//   GET /__requests?path=X   only those whose path ends with X
//   POST /__answer           { content } overrides the chat answer; null restores the fixed one
//   POST /__transcription    { failNext, status, delayMs, proportional, text } changes how
//                            transcription answers fail, stall or what text they return; any field
//                            left out keeps its current value
//   POST /__reset            clears the requests, the failure counter and the chat override
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
/**
 * How transcription answers behave. `failNext` requests answer with `status`,
 * `delayMs` postpones every answer, and `proportional` makes the segments span
 * the length of the uploaded audio instead of the fixed three seconds.
 */
const transcriptionControl = { failNext: 0, status: 500, delayMs: 0, proportional: false, text: null };
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

/** Seconds of audio in a WAV body, from its data chunk header. */
function wavSeconds(raw) {
    let offset = 12;
    while (offset + 8 <= raw.length) {
        const id = raw.toString("latin1", offset, offset + 4);
        const size = raw.readUInt32LE(offset + 4);
        if (id === "data") {
            const header = raw.toString("latin1", 0, Math.min(64, raw.length));
            const byteRate = header.startsWith("RIFF") ? wavByteRate(raw) : 0;
            return byteRate ? size / byteRate : 0;
        }
        offset += 8 + size + (size % 2);
    }
    return 0;
}

/** Bytes per second from the WAV `fmt ` chunk. */
function wavByteRate(raw) {
    let offset = 12;
    while (offset + 8 <= raw.length) {
        const id = raw.toString("latin1", offset, offset + 4);
        const size = raw.readUInt32LE(offset + 4);
        if (id === "fmt ") return raw.readUInt32LE(offset + 16);
        offset += 8 + size + (size % 2);
    }
    return 0;
}

/** Bytes of the single uploaded file part, for the audio headers. */
function formFile(raw, contentType) {
    const boundary = /boundary=(.+)$/.exec(contentType ?? "")?.[1];
    if (!boundary) return null;
    for (const part of raw.toString("latin1").split(`--${boundary}`)) {
        const headerEnd = part.indexOf("\r\n\r\n");
        if (headerEnd < 0 || !/filename="/.test(part.slice(0, headerEnd))) continue;
        const body = part.slice(headerEnd + 4, part.length - 2);
        return Buffer.from(body, "latin1");
    }
    return null;
}

function transcription(fields, file) {
    const base = {
        text: transcriptionControl.text ?? TRANSCRIPT_TEXT,
        language: "en",
        duration: 3,
    };
    if (fields.response_format === "text") return TRANSCRIPT_TEXT;
    if (fields.response_format === "diarized_json")
        return { ...base, segments: segments.map((s) => ({ ...s, type: "transcript.text.segment" })) };
    return { ...base, segments: segments.map(({ speaker, ...s }) => s) };
}

/**
 * A transcript whose segments span the uploaded audio. The pipeline rejects timestamps
 * that run past a chunk, so the answer has to follow the length of what it received.
 */
function proportionalTranscription(fields, file) {
    const seconds = file ? wavSeconds(file) : 0;
    const duration = seconds > 0 ? seconds : 3;
    const spans = [
        { start: 0, end: duration / 2, text: "First part of the recording." },
        { start: duration / 2, end: duration, text: "Second part of the recording." },
    ].filter((s) => s.end - s.start > 0.01);
    const answer = { text: spans.map((s) => s.text).join(" "), language: "en", duration };
    if (fields.response_format === "text") return answer.text;
    const payload = spans.map((s, id) => ({ id, ...s, speaker: id % 2 === 0 ? "A" : "B" }));
    if (fields.response_format === "diarized_json")
        return { ...answer, segments: payload.map((s) => ({ ...s, type: "transcript.text.segment" })) };
    return { ...answer, segments: payload.map(({ speaker, ...s }) => s) };
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
        if (req.method === "POST" && path === "/__transcription") {
            const body = raw.length ? JSON.parse(raw.toString("utf8")) : {};
            for (const key of ["failNext", "status", "delayMs", "proportional", "text"]) {
                if (body[key] !== undefined) transcriptionControl[key] = body[key];
            }
            return send(res, 200, transcriptionControl);
        }
        if (req.method === "POST" && path === "/__reset") {
            requests.length = 0;
            seq = 0;
            answerOverride = null;
            Object.assign(transcriptionControl, {
                failNext: 0,
                status: 500,
                delayMs: 0,
                text: null,
                proportional: false,
            });
            return send(res, 200, { ok: true });
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
            const file = formFile(raw, req.headers["content-type"]);
            const answer = () => {
                const body = transcriptionControl.proportional
                    ? proportionalTranscription(fields, file)
                    : transcription(fields, file);
                if (typeof body === "string") {
                    res.writeHead(200, { "content-type": "text/plain" });
                    return res.end(body);
                }
                send(res, 200, body);
            };
            if (transcriptionControl.failNext > 0) {
                transcriptionControl.failNext -= 1;
                return send(res, transcriptionControl.status, {
                    error: { message: "Transcription failed for this request" },
                });
            }
            if (transcriptionControl.delayMs > 0) {
                setTimeout(answer, transcriptionControl.delayMs);
                return;
            }
            return answer();
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
