import { LEGACY_SOURCE } from "@/lib/brand/legacy";

/** `source` value for transcripts and summaries this instance produced. */
export const OWN_SOURCE = "openaudiohub" as const;

/** Stored values that mean "produced by this instance": the current one and the legacy one. */
export const OWN_SOURCE_VALUES: string[] = [OWN_SOURCE, LEGACY_SOURCE];

/** Maps a stored value to the current vocabulary. Other values pass through unchanged. */
export function normalizeSource(value: string): string {
    return value === LEGACY_SOURCE ? OWN_SOURCE : value;
}

/** True for rows this instance produced, whichever vocabulary they were written in. */
export function isOwnSource(value: string | null | undefined): boolean {
    return value === OWN_SOURCE || value === LEGACY_SOURCE;
}
