import {
    STATUS_BADGE_STATUSES,
    type StatusBadgeStatus,
} from "@/components/app/status-badge";

/** The badge state for a pipeline phase. Unknown phases read as running. */
export function pipelinePhaseStatus(phase: string): StatusBadgeStatus {
    return (STATUS_BADGE_STATUSES as readonly string[]).includes(phase)
        ? (phase as StatusBadgeStatus)
        : "running";
}

/**
 * The badge state for a recording: an active pipeline job first, then its
 * transcript and summary.
 */
export function transcriptStatus(flags: {
    hasTranscript?: boolean;
    hasSummary?: boolean;
    pipelinePhase?: string | null;
}): StatusBadgeStatus {
    if (flags.pipelinePhase) return pipelinePhaseStatus(flags.pipelinePhase);
    if (flags.hasSummary) return "summary_ready";
    if (flags.hasTranscript) return "transcript_ready";
    return "transcript_missing";
}

/**
 * Plaud recordings carry a device serial number. Uploaded files do not: the
 * upload route stores the sentinel "local" in that column (its schema is NOT NULL),
 * so it counts as no device (D-158).
 */
export function recordingSource(
    deviceSn: string | null | undefined,
): "Plaud" | "Upload" {
    return deviceSn && deviceSn !== "local" ? "Plaud" : "Upload";
}
