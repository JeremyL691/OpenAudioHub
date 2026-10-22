/**
 * Reads the answer stream of one turn (spec/recording-chat.md, "GET …/events").
 *
 * The first event is the whole turn and later events are changes, so a stream that drops is
 * reopened and the answer it already had is kept: nothing here asks a provider for anything.
 */
import { chatEventsPath, type ChatTurn, type ChatTurnEvent } from "./types";

export interface StreamHandlers {
    onSnapshot(event: Extract<ChatTurnEvent, { type: "snapshot" }>): void;
    onDelta(event: Extract<ChatTurnEvent, { type: "delta" }>): void;
    onState(event: Extract<ChatTurnEvent, { type: "state" }>): void;
    onCitations(event: Extract<ChatTurnEvent, { type: "citations" }>): void;
    onDone(): void;
    onError(message: string): void;
}

/** Opens the stream and returns a function that closes it. */
export function openTurnStream(recordingId: string, turnId: string, handlers: StreamHandlers): () => void {
    const controller = new AbortController();
    void read(recordingId, turnId, handlers, controller.signal);
    return () => controller.abort();
}

async function read(recordingId: string, turnId: string, handlers: StreamHandlers, signal: AbortSignal): Promise<void> {
    let closed = false;
    try {
        const response = await fetch(chatEventsPath(recordingId, turnId), {
            credentials: "same-origin",
            headers: { accept: "text/event-stream" },
            signal,
        });
        if (!response.ok || !response.body) {
            handlers.onError(`Request failed (${response.status})`);
            return;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            // Events are separated by a blank line; the tail stays buffered for the next packet.
            let boundary = buffer.indexOf("\n\n");
            while (boundary >= 0) {
                const frame = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + 2);
                if (handle(frame, handlers)) closed = true;
                boundary = buffer.indexOf("\n\n");
            }
            if (closed) break;
        }
        if (!closed && buffer.trim()) {
            handle(buffer, handlers);
        }
        reader.cancel().catch(() => undefined);
    } catch (err) {
        if (signal.aborted) return;
        handlers.onError(err instanceof Error ? err.message : "The connection to the answer was lost.");
    }
}

/** Reads one event frame; true when it was the end of the turn. */
function handle(frame: string, handlers: StreamHandlers): boolean {
    let name = "message";
    const data: string[] = [];
    for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) name = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (data.length === 0) return false;
    const payload = safeJson(data.join("\n"));
    if (payload === null) return false;
    const version = typeof payload.version === "number" ? payload.version : 0;
    switch (name) {
        case "snapshot":
            handlers.onSnapshot({
                type: "snapshot",
                version,
                status: String(payload.status ?? ""),
                answer: String(payload.answer ?? ""),
                citations: Array.isArray(payload.citations) ? payload.citations : [],
                effort: effortOf(payload.effort),
                model: nullableString(payload.model),
                provider: nullableString(payload.provider),
                error: errorOf(payload.error),
            });
            break;
        case "delta":
            handlers.onDelta({ type: "delta", version, text: String(payload.text ?? "") });
            break;
        case "state":
            handlers.onState({ type: "state", version, status: String(payload.status ?? "") });
            break;
        case "citations":
            handlers.onCitations({ type: "citations", version, citations: Array.isArray(payload.citations) ? payload.citations : [] });
            break;
        case "done":
            handlers.onDone();
            return true;
        case "error":
            handlers.onError(String(payload.message ?? "The answer failed."));
            break;
        default:
            break;
    }
    return false;
}

function nullableString(value: unknown): string | null {
    return typeof value === "string" ? value : null;
}

function effortOf(value: unknown): ChatTurn["effort"] | null {
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    return {
        requested: nullableString(record.requested),
        sent: nullableString(record.sent),
        known: record.known === true,
    };
}

function errorOf(value: unknown): ChatTurn["error"] {
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    const code = nullableString(record.code);
    if (!code) return null;
    return { code, message: nullableString(record.message) ?? "" };
}

function safeJson(text: string): Record<string, unknown> | null {
    try {
        const parsed: unknown = JSON.parse(text);
        return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}
