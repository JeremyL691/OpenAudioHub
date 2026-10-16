import { waveformFallback } from "@/lib/notifications/email-templates/brand-colors";

/** Colours the waveform draws with, read from the theme tokens at draw time. */
export interface WaveformPalette {
    /** Colour of the played part of the waveform. A list so callers can draw a gradient. */
    playedStops: string[];
    /** The unplayed part of the waveform. */
    unplayed: string;
    /** The playhead and its glow. */
    primary: string;
    /** The hover line. */
    muted: string;
}

const FALLBACK = waveformFallback;

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
        playedStops: [token("--waveform-played", FALLBACK.primary)],
        unplayed: token("--waveform-unplayed", FALLBACK.muted),
        primary: token("--primary", FALLBACK.primary),
        muted: token("--muted-foreground", FALLBACK.muted),
    };
}
