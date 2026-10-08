import { cn } from "@/lib/utils";

interface ProgressBarProps {
    /** Fraction complete, from 0 to 1. Out-of-range values clamp to the ends. */
    value: number;
    /** Accessible name, for example "Weekly team sync progress". */
    label: string;
    className?: string;
}

/**
 * Determinate progress in the brand gradient on a neutral track. Use it instead
 * of a native <progress>, whose fill takes the browser's accent colour. DESIGN.md
 * places the brand gradient on playback and pipeline progress.
 */
export function ProgressBar({ value, label, className }: ProgressBarProps) {
    const fraction = Number.isFinite(value)
        ? Math.min(1, Math.max(0, value))
        : 0;
    const percent = Math.round(fraction * 100);

    return (
        <div
            role="progressbar"
            aria-label={label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className={cn(
                "h-1.5 w-full overflow-hidden rounded-full bg-muted",
                className,
            )}
        >
            <div
                className="h-full rounded-full bg-brand-gradient transition-[width] duration-300 ease-out"
                style={{ width: `${percent}%` }}
            />
        </div>
    );
}
