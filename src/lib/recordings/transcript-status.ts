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
