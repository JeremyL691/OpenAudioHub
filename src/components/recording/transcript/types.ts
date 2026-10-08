/** A transcript variant for a single source (Plaud, the user's own, etc.). */
export interface TranscriptOption {
    source: string;
    text: string;
    language?: string;
    provider?: string;
    model?: string;
}
