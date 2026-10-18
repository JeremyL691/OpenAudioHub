import type { Recording } from "@/lib/recordings";

/** Phase labels of the audio pipeline (spec/ui-library.md section 7). */
export const PHASE_LABELS: Record<string, string> = {
    queued: "Waiting to start",
    download: "Fetching the original audio",
    decode: "Preparing the audio",
    vad: "Looking for speech",
    chunking: "Splitting speech into segments",
    transcribing: "Transcribing the audio",
    completed: "Transcription done",
    needs_alignment: "Saved without timestamps",
    paused_disk: "Paused: waiting for free disk space",
    failed: "Transcription failed",
    cancelled: "Transcription cancelled",
};

/** The label for a phase. Unknown phases read "Processing transcription". */
export function phaseLabel(phase: string | null | undefined): string {
    if (!phase) return "Processing transcription";
    return PHASE_LABELS[phase] ?? "Processing transcription";
}

/** Row status labels, */
export const RECORDING_STAGE_LABELS = {
    untranscribed: "Not transcribed",
    transcribed: "Transcript ready",
    summarized: "Summary ready",
    transcribing: "Transcribing",
    summarizing: "Summarizing",
} as const;

export type RecordingStage = keyof typeof RECORDING_STAGE_LABELS;

/** The status a recording row shows. A running job wins over the saved results. */
export function recordingStage(r: Pick<Recording, "processing" | "hasTranscript" | "hasSummary">): RecordingStage {
    if (r.processing) return r.processing.kind === "summary" ? "summarizing" : "transcribing";
    if (r.hasSummary) return "summarized";
    if (r.hasTranscript) return "transcribed";
    return "untranscribed";
}
