/** Loads one recording's chat and keeps it in step with a running answer. */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, errorMessage } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { openTurnStream } from "./events";
import { chatPath, chatTurnsPath, isFinalStatus, type ChatData, type ChatTurn } from "./types";

export interface ChatState {
    data: ChatData | null;
    status: "loading" | "ready" | "error";
    message: string | null;
    /** The text of the answer as it arrives, before it is saved. */
    live: { turnId: string; text: string } | null;
    reload(): Promise<void>;
    ask(question: string, requestId: string): Promise<ChatTurn | null>;
    stop(turnId: string): Promise<void>;
    retry(turnId: string): Promise<void>;
    clear(): Promise<void>;
}

export function useChat(recordingId: string, source: string | null, onCleared?: () => void): ChatState {
    const { t } = useI18n();
    const [data, setData] = useState<ChatData | null>(null);
    const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
    const [message, setMessage] = useState<string | null>(null);
    const [live, setLive] = useState<{ turnId: string; text: string } | null>(null);
    const closeStream = useRef<(() => void) | null>(null);
    const alive = useRef(true);

    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
            closeStream.current?.();
            closeStream.current = null;
        };
    }, [recordingId]);

    const reload = useCallback(async () => {
        try {
            const next = await api<ChatData>(chatPath(recordingId, source));
            if (!alive.current) return;
            setData(next);
            setStatus("ready");
        } catch (err) {
            if (!alive.current) return;
            setStatus((prev) => (prev === "ready" ? "ready" : "error"));
            setMessage(errorMessage(err, t("recording.chat.loadFailed")));
        }
    }, [recordingId, source, t]);

    useEffect(() => {
        void reload();
    }, [reload]);

    // Watches the running answer, if there is one. The first event is the whole turn, so a
    // reconnect needs nothing else and no provider is asked again.
    const activeId = data?.activeTurn?.id ?? null;
    useEffect(() => {
        closeStream.current?.();
        closeStream.current = null;
        if (!activeId) {
            setLive(null);
            return;
        }
        const turnId = activeId;
        setLive((current) => (current?.turnId === turnId ? current : { turnId, text: "" }));
        let finished = false;
        const close = openTurnStream(recordingId, turnId, {
            onSnapshot(event) {
                setLive({ turnId, text: event.answer });
                if (isFinalStatus(event.status)) finished = true;
            },
            onDelta(event) {
                setLive((current) => ({
                    turnId,
                    text: (current?.turnId === turnId ? current.text : "") + event.text,
                }));
            },
            onState(event) {
                if (isFinalStatus(event.status)) finished = true;
            },
            onCitations() {
                // Citations arrive with the saved turn; the reload below shows them.
            },
            onDone() {
                void reload();
            },
            onError(text) {
                setMessage(text);
                void reload();
            },
        });
        closeStream.current = close;
        return () => {
            close();
            if (finished) void reload();
        };
    }, [activeId, recordingId, reload]);

    const ask = useCallback(
        async (question: string, requestId: string): Promise<ChatTurn | null> => {
            try {
                const answer = await api<{ turn: ChatTurn }>(chatTurnsPath(recordingId), {
                    method: "POST",
                    json: { question, requestId, revision: data?.revision ?? undefined, source: source ?? undefined },
                });
                setMessage(null);
                await reload();
                return answer.turn;
            } catch (err) {
                // A transcript that moved on is worth re-reading, so the next try has the new one.
                if (err instanceof ApiError) await reload();
                setMessage(errorMessage(err, t("recording.chat.sendFailed")));
                return null;
            }
        },
        [data?.revision, recordingId, reload, source, t],
    );

    const stop = useCallback(
        async (turnId: string) => {
            try {
                await api(`${chatTurnsPath(recordingId)}/${encodeURIComponent(turnId)}/cancel`, { method: "POST" });
            } catch (err) {
                setMessage(errorMessage(err, t("recording.chat.stopFailed")));
            }
            closeStream.current?.();
            closeStream.current = null;
            setLive(null);
            await reload();
        },
        [recordingId, reload, t],
    );

    const retry = useCallback(
        async (turnId: string) => {
            try {
                await api(`${chatTurnsPath(recordingId)}/${encodeURIComponent(turnId)}/retry`, { method: "POST" });
                setMessage(null);
                await reload();
            } catch (err) {
                setMessage(errorMessage(err, t("recording.chat.retryFailed")));
            }
        },
        [recordingId, reload, t],
    );

    const clear = useCallback(async () => {
        try {
            await api(chatPath(recordingId), { method: "DELETE" });
            closeStream.current?.();
            closeStream.current = null;
            setLive(null);
            onCleared?.();
            await reload();
        } catch (err) {
            setMessage(errorMessage(err, t("recording.chat.clearFailed")));
        }
    }, [onCleared, recordingId, reload, t]);

    return { data, status, message, live, reload, ask, stop, retry, clear };
}
