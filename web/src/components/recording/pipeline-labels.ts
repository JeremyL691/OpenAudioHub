import type { Recording } from "@/lib/recordings";
import { t, type MessageKey } from "@/lib/i18n";

/** Phase labels of the audio pipeline (spec/ui-library.md section 7), as translation keys. */
export const PHASE_LABELS: Record<string, MessageKey> = {
    queued: "recording.phase.queued",
    download: "recording.phase.download",
    decode: "recording.phase.decode",
    vad: "recording.phase.vad",
    chunking: "recording.phase.chunking",
    transcribing: "recording.phase.transcribing",
    completed: "recording.phase.completed",
    needs_alignment: "recording.phase.needsAlignment",
    paused_disk: "recording.phase.pausedDisk",
    failed: "recording.phase.failed",
    cancelled: "recording.phase.cancelled",
};

/** The label for a phase in the current language. Unknown phases read "Processing transcription". */
export function phaseLabel(phase: string | null | undefined): string {
    if (!phase) return t("recording.phase.unknown");
    const key = PHASE_LABELS[phase];
    return key ? t(key) : t("recording.phase.unknown");
}

/** Row status labels, as translation keys. */
export const RECORDING_STAGE_LABELS = {
    untranscribed: "recording.stage.untranscribed",
    transcribed: "recording.stage.transcribed",
    summarized: "recording.stage.summarized",
    transcribing: "recording.stage.transcribing",
    summarizing: "recording.stage.summarizing",
} as const satisfies Record<string, MessageKey>;

export type RecordingStage = keyof typeof RECORDING_STAGE_LABELS;

/** The label for a row stage in the current language. */
export function stageLabel(stage: RecordingStage): string {
    return t(RECORDING_STAGE_LABELS[stage]);
}

/** The status a recording row shows. A running job wins over the saved results. */
export function recordingStage(r: Pick<Recording, "processing" | "hasTranscript" | "hasSummary">): RecordingStage {
    if (r.processing) return r.processing.kind === "summary" ? "summarizing" : "transcribing";
    if (r.hasSummary) return "summarized";
    if (r.hasTranscript) return "transcribed";
    return "untranscribed";
}
