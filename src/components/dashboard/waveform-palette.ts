/** Colours the waveform draws with, read from the theme tokens at draw time. */
export interface WaveformPalette {
    /** Gradient stops for the played part of the waveform, left to right. */
    playedStops: string[];
    /** The playhead and its glow. */
    primary: string;
    /** The unplayed part of the waveform and the hover line. */
    muted: string;
}

const FALLBACK = {
    cyan: "oklch(0.72 0.15 230)",
    blue: "oklch(0.58 0.22 262)",
    violet: "oklch(0.55 0.25 290)",
    primary: "oklch(0.2038 0.0264 260.9332)",
    muted: "rgba(0,0,0,0.5)",
};

/**
 * Builds the waveform palette from a token reader (usually
 * `getComputedStyle(el).getPropertyValue`). Every token falls back to a
 * Chalk value, so the waveform still draws if a token is missing.
 */
export function readWaveformPalette(
    read: (name: string) => string,
): WaveformPalette {
    const token = (name: string, fallback: string) =>
        read(name).trim() || fallback;
    return {
        playedStops: [
            token("--brand-cyan", FALLBACK.cyan),
            token("--brand-blue", FALLBACK.blue),
            token("--brand-violet", FALLBACK.violet),
        ],
        primary: token("--primary", FALLBACK.primary),
        muted: token("--muted-foreground", FALLBACK.muted),
    };
}
