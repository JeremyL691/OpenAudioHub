"use client";

import { Cpu, Loader2 } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { runBrowserTranscription } from "@/lib/transcription/browser-run";
import type { TranscriptionModel } from "@/types/transcription";

interface Props {
    recordingId: string;
    /** Disabled while another action is running. */
    disabled?: boolean;
    /** Called after a successful POST so the parent can refresh data. */
    onComplete: () => void;
    /** Defaults to `"whisper-base"` (~75MB download, multilingual). */
    model?: TranscriptionModel;
}

type Phase =
    | "idle"
    | "downloading-audio"
    | "decoding-audio"
    | "loading-model"
    | "transcribing";

const PHASE_LABEL: Record<Exclude<Phase, "idle">, string> = {
    "downloading-audio": "Downloading audio…",
    "decoding-audio": "Decoding audio…",
    "loading-model": "Loading Whisper (one-time download)…",
    transcribing: "Transcribing locally…",
};

/**
 * Run Whisper in the browser via Transformers.js, then POST the result
 * to `/api/recordings/[id]/transcription/from-browser`. No API key
 * needed; audio never leaves the user's machine.
 *
 * The Whisper model is fetched from the Hugging Face CDN on first use
 * (~75MB for whisper-base) and cached by the browser, so subsequent
 * transcriptions are instant-start. Cancellation is best-effort: if the
 * user closes the tab mid-transcribe the worker is terminated by the
 * browser.
 */
export function TranscribeInBrowserButton({
    recordingId,
    disabled,
    onComplete,
    model = "whisper-base",
}: Props) {
    const [phase, setPhase] = useState<Phase>("idle");

    const run = useCallback(async () => {
        try {
            await runBrowserTranscription(recordingId, model, setPhase);
            toast.success("Transcribed in browser");
            onComplete();
        } catch (err) {
            toast.error(
                err instanceof Error
                    ? err.message
                    : "Browser transcription failed",
            );
        } finally {
            setPhase("idle");
        }
    }, [recordingId, model, onComplete]);

    const busy = phase !== "idle";

    return (
        <Button
            onClick={run}
            size="sm"
            variant="outline"
            disabled={disabled || busy}
            title="Run Whisper in your browser. No API key required; audio never leaves your machine."
        >
            {busy ? (
                <>
                    <Loader2 className="size-4 mr-2 animate-spin" />
                    {PHASE_LABEL[phase as Exclude<Phase, "idle">]}
                </>
            ) : (
                <>
                    <Cpu className="size-4 mr-2" />
                    Transcribe in browser
                </>
            )}
        </Button>
    );
}
