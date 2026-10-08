import type { StatusBadgeStatus } from "@/components/app/status-badge";

/** The badge state for a recording's transcript and summary. */
export function transcriptStatus(flags: {
    hasTranscript?: boolean;
    hasSummary?: boolean;
}): StatusBadgeStatus {
    if (flags.hasSummary) return "summary_ready";
    if (flags.hasTranscript) return "transcript_ready";
    return "transcript_missing";
}

/** Plaud recordings carry a device serial number; uploaded files do not. */
export function recordingSource(
    deviceSn: string | null | undefined,
): "Plaud" | "Upload" {
    return deviceSn ? "Plaud" : "Upload";
}
