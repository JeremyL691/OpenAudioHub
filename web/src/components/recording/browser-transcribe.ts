import { useCallback, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { type BrowserAsrStage, transcribeRecordingInBrowser } from "@/lib/browser-asr";

function stageLabel(s: BrowserAsrStage): string {
    switch (s.stage) {
        case "decode":
            return "Decoding audio…";
        case "model":
            return `Loading model… ${s.percent}%`;
        case "transcribe":
            return "Transcribing…";
        case "save":
            return "Saving…";
    }
}

async function defaultLanguage(): Promise<string | null> {
    try {
        const settings = await api<{ defaultTranscriptionLanguage?: string | null }>("/api/settings/user");
        return settings.defaultTranscriptionLanguage ?? null;
    } catch {
        return null;
    }
}

// Runs in flight, shared by every entry point so the same recording cannot be transcribed twice at once.
const inFlight = new Map<string, { label: string }>();
const listeners = new Set<() => void>();

function setInFlight(recordingId: string, label: string | null) {
    if (label === null) inFlight.delete(recordingId);
    else inFlight.set(recordingId, { label });
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/**
 * Transcribes a recording in the browser (Whisper, no API key, audio stays on the machine).
 * Toasts follow spec/ui-library.md; `onDone` refreshes the caller. A recording that is already
 * running is left alone.
 */
export async function transcribeInBrowser(
    recordingId: string,
    onStage: (label: string) => void = () => {},
    onDone: () => void = () => {},
): Promise<void> {
    if (inFlight.has(recordingId)) return;
    const first = stageLabel({ stage: "decode" });
    setInFlight(recordingId, first);
    const toastId = toast.loading("Transcribing in browser…");
    try {
        const language = await defaultLanguage();
        await transcribeRecordingInBrowser(recordingId, language, (s) => {
            const label = stageLabel(s);
            setInFlight(recordingId, label);
            onStage(label);
        });
        toast.success("Transcribed in browser", { id: toastId });
        onDone();
    } catch (error) {
        const message = error instanceof Error && error.message ? error.message : "Browser transcription failed";
        toast.error(message, { id: toastId });
    } finally {
        setInFlight(recordingId, null);
    }
}

/** Runs browser transcription for one recording and exposes the current step for the button label. */
export function useBrowserTranscription(recordingId: string, onDone: () => void) {
    const run = useSyncExternalStore(subscribe, () => inFlight.get(recordingId));
    const label = run?.label ?? null;
    const start = useCallback(() => {
        if (inFlight.has(recordingId)) return;
        void transcribeInBrowser(recordingId, undefined, onDone);
    }, [recordingId, onDone]);
    return { running: label !== null, label, start };
}
