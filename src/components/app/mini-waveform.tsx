import { cn } from "@/lib/utils";

export interface MiniWaveformProps {
    /** Normalized peaks in [0, 1]; null draws a flat placeholder. */
    peaks: number[] | null | undefined;
    /** Number of bars to draw. */
    bars?: number;
    /** Fraction in [0, 1] drawn in the played color. */
    progress?: number;
    className?: string;
}

/** Downsamples peaks to `bars` values by taking the max of each bucket. */
export function downsamplePeaks(peaks: number[], bars: number): number[] {
    if (peaks.length <= bars) return peaks.slice();
    const ratio = peaks.length / bars;
    return Array.from({ length: bars }, (_, i) => {
        let max = 0;
        for (
            let j = Math.floor(i * ratio);
            j < Math.floor((i + 1) * ratio);
            j++
        )
            max = Math.max(max, peaks[j] ?? 0);
        return max;
    });
}

/**
 * A small static waveform for list rows and cards. Decorative: the caller
 * describes the recording in text, so this is hidden from assistive tech.
 * Bars inherit `currentColor`; the played part uses `text-waveform-played`.
 */
export function MiniWaveform({
    peaks,
    bars = 16,
    progress = 0,
    className,
}: MiniWaveformProps) {
    const values = peaks?.length
        ? downsamplePeaks(peaks, bars)
        : Array.from({ length: bars }, () => 0.12);
    const played = Math.round(progress * values.length);
    return (
        <span
            aria-hidden="true"
            className={cn(
                "flex h-6 items-center gap-px text-waveform-unplayed",
                className,
            )}
        >
            {values.map((value, i) => (
                <span
                    // biome-ignore lint/suspicious/noArrayIndexKey: bars are positional and never reorder
                    key={i}
                    className={cn(
                        "min-h-0.5 flex-1 rounded-full bg-current",
                        i < played && "text-waveform-played",
                    )}
                    style={{ height: `${Math.max(8, value * 100)}%` }}
                />
            ))}
        </span>
    );
}
