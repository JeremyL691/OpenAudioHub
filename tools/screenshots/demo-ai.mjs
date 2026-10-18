// Chat-completions-style stub for the screenshot run. It answers transcription and
// summary requests with demo content chosen by the recording's title, so the
// screenshots show believable text. It never leaves the local machine.
// Usage: demo-ai.mjs <port>
import { createServer } from "node:http";
import { DEMO_RECORDINGS } from "./demo-data.mjs";

const port = Number(process.argv[2] ?? 3291);

function send(res, status, body) {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
}

/** Multipart `filename` of the audio part, decoded as UTF-8 when possible. */
function audioFilename(raw) {
    const text = raw.toString("latin1");
    const name = /filename="([^"]*)"/.exec(text)?.[1] ?? "";
    return Buffer.from(name, "latin1").toString("utf8");
}

function multipartFields(raw, contentType) {
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

function messageText(messages) {
    const parts = [];
    for (const m of messages ?? []) {
        if (typeof m.content === "string") parts.push(m.content);
        else if (Array.isArray(m.content))
            for (const p of m.content) if (p?.type === "text") parts.push(p.text ?? "");
    }
    return parts.join("\n");
}

function segmentsOf(recording) {
    return recording.lines.map((line, i) => ({
        id: i,
        start: i * 18,
        end: i * 18 + 16,
        text: line.text,
        speaker: line.speaker,
    }));
}

function transcription(recording, fields) {
    const segments = segmentsOf(recording);
    const text = segments.map((s) => s.text).join(" ");
    if (fields.response_format === "text") return text;
    const duration = segments.at(-1).end;
    if (fields.response_format === "diarized_json")
        return { text, language: "en", duration, segments: segments.map((s) => ({ ...s, type: "transcript.text.segment" })) };
    return { text, language: "en", duration, segments: segments.map(({ speaker, ...s }) => s) };
}

createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
        const raw = Buffer.concat(chunks);
        const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
        const path = url.pathname.replace(/^\/v1/, "");

        if (req.method === "GET" && path === "/models") {
            return send(res, 200, {
                object: "list",
                data: [
                    { id: "demo-whisper-1", object: "model" },
                    { id: "demo-chat-1", object: "model" },
                ],
            });
        }

        if (req.method === "POST" && path === "/audio/transcriptions") {
            const name = audioFilename(raw);
            const recording = DEMO_RECORDINGS.find((r) => name.includes(r.match)) ?? DEMO_RECORDINGS[0];
            const body = transcription(recording, multipartFields(raw, req.headers["content-type"]));
            if (typeof body === "string") {
                res.writeHead(200, { "content-type": "text/plain" });
                return res.end(body);
            }
            return send(res, 200, body);
        }

        if (req.method === "POST" && path === "/chat/completions") {
            let json = null;
            try {
                json = JSON.parse(raw.toString("utf8"));
            } catch {}
            const text = json ? messageText(json.messages) : "";
            const recording = DEMO_RECORDINGS.find((r) => text.includes(r.lines[0].text.slice(0, 40))) ?? DEMO_RECORDINGS[0];
            const wantsJson = Boolean(json?.response_format) || /\bjson\b/i.test(text);
            const content = wantsJson
                ? JSON.stringify({
                      title: recording.title,
                      summary: recording.summary,
                      keyPoints: recording.keyPoints,
                      actionItems: recording.actionItems,
                  })
                : recording.summary;
            return send(res, 200, {
                id: "chatcmpl-demo",
                object: "chat.completion",
                created: 0,
                model: json?.model ?? "demo-chat-1",
                choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            });
        }

        send(res, 404, { error: { message: `no demo answer for ${req.method} ${path}` } });
    });
}).listen(port, "127.0.0.1", () => {
    console.log(`demo AI listening on http://127.0.0.1:${port}/v1`);
});
