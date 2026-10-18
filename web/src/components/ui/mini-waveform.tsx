import { cn } from "@/lib/cn";

export interface MiniWaveformProps {
    /** Peak amplitudes from 0 to 1. When null or empty, every bar is drawn at the minimum height as a dotted placeholder. */
    peaks: number[] | null;
    /** How many bars to draw. */
    bars?: number;
    /** Played share from 0 to 1. Bars past it are faded. Omit to draw every bar at full strength. */
    progress?: number;
    className?: string;
}

/** A decorative waveform of thin rounded bars. It is hidden from assistive technology and takes its colour from currentColor. The caller sets its size; `cn` does not merge conflicting classes. */
export function MiniWaveform({ peaks, bars = 48, progress, className }: MiniWaveformProps) {
    const heights = peaks && peaks.length > 0 ? downsample(peaks, bars) : null;
    const playedBars = progress === undefined ? bars : Math.round(Math.min(1, Math.max(0, progress)) * bars);

    return (
        <div aria-hidden="true" className={cn("flex items-center gap-px", className)}>
            {Array.from({ length: bars }, (_, i) => (
                <span
                    key={i}
                    className={cn("min-h-0.5 flex-1 rounded-full bg-current", i >= playedBars && "opacity-30")}
                    style={{ height: `${Math.max(12, (heights ? heights[i] : 0) * 100)}%` }}
                />
            ))}
        </div>
    );
}

function downsample(peaks: number[], bars: number): number[] {
    const out: number[] = [];
    for (let b = 0; b < bars; b++) {
        const start = Math.floor((b * peaks.length) / bars);
        const end = Math.max(start + 1, Math.floor(((b + 1) * peaks.length) / bars));
        let max = 0;
        for (let i = start; i < end && i < peaks.length; i++) max = Math.max(max, peaks[i]);
        out.push(Math.min(1, Math.max(0, max)));
    }
    return out;
}
