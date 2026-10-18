import type { HTMLAttributes } from "react";
import { CircleCheck, CircleDashed, LoaderCircle, Sparkles, type LucideIcon } from "lucide-react";
import { RECORDING_STAGE_LABELS, type RecordingStage } from "@/components/recording/pipeline-labels";
import { cn } from "@/lib/cn";

export type StatusTone = "success" | "info" | "warning" | "neutral" | "muted";

const tones: Record<StatusTone, string> = {
    success: "bg-success text-success-foreground",
    info: "bg-info text-info-foreground",
    warning: "bg-warning text-warning-foreground",
    neutral: "bg-secondary text-secondary-foreground",
    muted: "bg-muted text-muted-foreground",
};

export interface StatusBadgeProps extends HTMLAttributes<HTMLSpanElement> {
    tone?: StatusTone;
    /** White pill with primary text, for a badge sitting on a selected (primary) row. */
    inverted?: boolean;
}

/** A small pill for a status word such as "Transcript ready" or "Processing". Text carries the meaning, not the colour. An icon child is sized automatically. */
export function StatusBadge({ tone = "neutral", inverted = false, className, ...props }: StatusBadgeProps) {
    return (
        <span
            className={cn(
                "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium [&>svg]:size-3 [&>svg]:shrink-0",
                inverted ? "bg-primary-foreground text-primary" : tones[tone],
                className,
            )}
            {...props}
        />
    );
}

const STAGE_VIEW: Record<RecordingStage, { tone: StatusTone; icon: LucideIcon; busy: boolean }> = {
    untranscribed: { tone: "muted", icon: CircleDashed, busy: false },
    transcribed: { tone: "success", icon: CircleCheck, busy: false },
    summarized: { tone: "success", icon: Sparkles, busy: false },
    transcribing: { tone: "info", icon: LoaderCircle, busy: true },
    summarizing: { tone: "info", icon: LoaderCircle, busy: true },
};

/** The status badge of a recording row, with the icon and wording of the library. */
export function RecordingStatusBadge({ stage, inverted = false, className }: { stage: RecordingStage; inverted?: boolean; className?: string }) {
    const view = STAGE_VIEW[stage];
    const Icon = view.icon;
    return (
        <StatusBadge tone={view.tone} inverted={inverted} className={className}>
            <Icon aria-hidden="true" className={cn(view.busy && "animate-spin motion-reduce:animate-none")} />
            {RECORDING_STAGE_LABELS[stage]}
        </StatusBadge>
    );
}
