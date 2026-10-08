import {
    AlertTriangle,
    AudioWaveform,
    Ban,
    CheckCircle2,
    CircleDashed,
    Clock,
    Download,
    FileText,
    HardDrive,
    LoaderCircle,
    type LucideIcon,
    Mic,
    PauseCircle,
    Scissors,
    Send,
    Sparkles,
    XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Every state a transcription job, its phase, or a recording's transcript and
 * summary can show. Job statuses and phases come from the audio pipeline and
 * Core. Content states come from the recording.
 */
export const STATUS_BADGE_STATUSES = [
    "queued",
    "submitted",
    "running",
    "paused",
    "download",
    "decode",
    "vad",
    "chunking",
    "transcribing",
    "paused_disk",
    "completed",
    "needs_alignment",
    "failed",
    "cancelled",
    "transcript_ready",
    "transcript_missing",
    "summary_ready",
    "summary_missing",
    "summary_generating",
    "summary_failed",
] as const;

export type StatusBadgeStatus = (typeof STATUS_BADGE_STATUSES)[number];

type StatusTone = "neutral" | "info" | "success" | "warning" | "danger";

interface StatusDefinition {
    label: string;
    tone: StatusTone;
    icon: LucideIcon;
    /** The icon turns while work is in progress. Motion is off for reduced-motion users. */
    spin?: boolean;
}

const STATUS_DEFINITIONS: Record<StatusBadgeStatus, StatusDefinition> = {
    queued: { label: "Waiting to process audio", tone: "neutral", icon: Clock },
    submitted: { label: "Submitted", tone: "neutral", icon: Send },
    running: {
        label: "Processing",
        tone: "info",
        icon: LoaderCircle,
        spin: true,
    },
    paused: { label: "Paused", tone: "warning", icon: PauseCircle },
    download: {
        label: "Reading original audio",
        tone: "info",
        icon: Download,
        spin: true,
    },
    decode: {
        label: "Preparing audio",
        tone: "info",
        icon: AudioWaveform,
        spin: true,
    },
    vad: { label: "Detecting speech", tone: "info", icon: Mic, spin: true },
    chunking: {
        label: "Preparing speech segments",
        tone: "info",
        icon: Scissors,
        spin: true,
    },
    transcribing: {
        label: "Transcribing speech",
        tone: "info",
        icon: FileText,
        spin: true,
    },
    paused_disk: {
        label: "Paused for disk space",
        tone: "warning",
        icon: HardDrive,
    },
    completed: {
        label: "Transcription complete",
        tone: "success",
        icon: CheckCircle2,
    },
    needs_alignment: {
        label: "Transcript saved without timestamps",
        tone: "warning",
        icon: AlertTriangle,
    },
    failed: { label: "Transcription failed", tone: "danger", icon: XCircle },
    cancelled: {
        label: "Transcription cancelled",
        tone: "neutral",
        icon: Ban,
    },
    transcript_ready: {
        label: "Transcript ready",
        tone: "success",
        icon: CheckCircle2,
    },
    transcript_missing: {
        label: "Not transcribed",
        tone: "neutral",
        icon: CircleDashed,
    },
    summary_ready: {
        label: "Summary ready",
        tone: "success",
        icon: Sparkles,
    },
    summary_missing: {
        label: "No summary",
        tone: "neutral",
        icon: CircleDashed,
    },
    summary_generating: {
        label: "Summarizing",
        tone: "info",
        icon: LoaderCircle,
        spin: true,
    },
    summary_failed: {
        label: "Summary failed",
        tone: "danger",
        icon: XCircle,
    },
};

// Each tone is a background token paired with its foreground token, so the
// contrast of every chip can be checked from globals.css.
const TONE_CLASSES: Record<StatusTone, string> = {
    neutral: "bg-muted text-muted-foreground",
    info: "bg-info text-info-foreground",
    success: "bg-success text-success-foreground",
    warning: "bg-warning text-warning-foreground",
    danger: "bg-destructive text-destructive-foreground",
};

/** The text a status shows. The same text is what a screen reader announces. */
export function statusLabel(status: StatusBadgeStatus): string {
    return STATUS_DEFINITIONS[status].label;
}

export interface StatusBadgeProps {
    status: StatusBadgeStatus;
    className?: string;
}

/** A status chip with an icon, its text, and a tone. Use it for job, phase, and content states. */
export function StatusBadge({ status, className }: StatusBadgeProps) {
    const definition = STATUS_DEFINITIONS[status];
    const Icon = definition.icon;
    return (
        <Badge
            data-status={status}
            className={cn(
                "gap-1.5 border-transparent font-medium",
                TONE_CLASSES[definition.tone],
                className,
            )}
        >
            <Icon
                aria-hidden="true"
                className={cn(
                    "size-3.5",
                    definition.spin && "motion-safe:animate-spin",
                )}
            />
            {definition.label}
        </Badge>
    );
}
