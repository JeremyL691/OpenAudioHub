/** Recording chat shapes (spec/recording-chat.md). */

export type ChatStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "interrupted" | "stale";

/** The thinking levels, in the order the app offers them (spec "Effort resolution"). */
export const EFFORT_LEVELS = ["default", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

/**
 * Where a cited unit sits in the transcript the detail shows (spec/recording-chat.md "Citations").
 *
 * A timed transcript is cited by rows of its timeline: `segmentStart..segmentEnd` (inclusive) are
 * indexes into `transcript.timeline`. A plain transcript is cited by a line: `line` counts the lines
 * the detail shows (split on "\n", trimmed, blank lines skipped) and `lineStart..lineEnd` is the
 * cited part of that trimmed line in UTF-16 code units, which is what `String.slice` uses. All of
 * them are null once the transcript changed under the answer.
 */
export interface CitationPlace {
    segmentStart: number | null;
    segmentEnd: number | null;
    line: number | null;
    lineStart: number | null;
    lineEnd: number | null;
}

export interface ChatCitation extends CitationPlace {
    sourceId: string;
    /** The cited words, at most 240 characters. */
    quote: string;
    speaker: string | null;
    startMs: number | null;
    endMs: number | null;
    /** True when the transcript's times were corrected, so the time is a rough place to start. */
    approximate: boolean;
}

export interface CitationTarget extends CitationPlace {
    recordingId: string;
    turnId: string;
    sourceId: string;
    transcriptId: string;
    /** The transcript source the answer was given from; the detail switches to it. */
    source: string;
    revision: string;
    current: boolean;
    quote: string;
    speaker: string | null;
    startMs: number | null;
    endMs: number | null;
    approximate: boolean;
}

/** What the transcript view marks after a citation was opened. */
export interface CitationFocus extends CitationPlace {
    startMs: number | null;
    endMs: number | null;
    /** Changes on every open, so opening the same citation twice scrolls and marks again. */
    key: number;
}

export interface ChatTurn {
    id: string;
    seq: number;
    status: ChatStatus;
    question: string;
    answer: string;
    citations: ChatCitation[];
    /** True when only part of the transcript was read for this answer. */
    partial: boolean;
    /** False when the transcript changed after this answer; its citations then have no place. */
    current?: boolean;
    provider: string | null;
    model: string | null;
    effort: { requested: string | null; sent: string | null; known: boolean };
    error: { code: string; message: string } | null;
    createdAt: string;
    finishedAt: string | null;
}

export interface ChatTranscript {
    id: string;
    source: string;
    hasTimeline: boolean;
    timelineSource: string | null;
    createdAt: string;
}

export interface ChatData {
    recordingId: string;
    generation: number;
    revision: string | null;
    preference: { providerId: string | null; provider: string | null; model: string | null; effort: string | null };
    capabilities: { effort: string[]; known: boolean };
    canAsk: boolean;
    blockedReason: "noTranscript" | "noProvider" | "providerMissing" | "busy" | null;
    transcript: ChatTranscript | null;
    activeTurn: ChatTurn | null;
    turns: ChatTurn[];
}

export interface ChatModelRow {
    id: string;
    name: string;
}

export type ChatTurnEvent =
    | {
          type: "snapshot";
          version: number;
          status: string;
          answer: string;
          citations: ChatCitation[];
          effort: ChatTurn["effort"] | null;
          model: string | null;
          provider: string | null;
          error: ChatTurn["error"];
      }
    | { type: "delta"; version: number; text: string }
    | { type: "state"; version: number; status: string }
    | { type: "citations"; version: number; citations: ChatCitation[] };

export function chatPath(recordingId: string, source?: string | null): string {
    const base = `/api/recordings/${encodeURIComponent(recordingId)}/chat`;
    return source ? `${base}?source=${encodeURIComponent(source)}` : base;
}

export function chatTurnsPath(recordingId: string): string {
    return `/api/recordings/${encodeURIComponent(recordingId)}/chat/turns`;
}

export function chatEventsPath(recordingId: string, turnId: string): string {
    return `${chatTurnsPath(recordingId)}/${encodeURIComponent(turnId)}/events`;
}

export function chatCitationPath(recordingId: string, turnId: string, sourceId: string): string {
    return `${chatTurnsPath(recordingId)}/${encodeURIComponent(turnId)}/citations/${encodeURIComponent(sourceId)}`;
}

/** True for a state nothing more will change. */
export function isFinalStatus(status: string): boolean {
    return ["completed", "failed", "cancelled", "interrupted", "stale"].includes(status);
}

/** Matches one citation marker in an answer: `[src_3]`, `[src_3, src_4]` or the full-width forms. */
export const CITATION_MARKER = /[\[【]\s*(src_\d+(?:\s*[,，、]\s*src_\d+)*)\s*[\]】]/g;

/**
 * The number each cited source shows, in the order the answer first cites it. The badges in the
 * text and the source list below the answer both use this, so they always agree.
 */
export function citationNumbers(answer: string, citations: ChatCitation[]): Map<string, number> {
    const known = new Set(citations.map((citation) => citation.sourceId));
    const numbers = new Map<string, number>();
    for (const match of answer.matchAll(CITATION_MARKER)) {
        for (const id of match[1].split(/[,，、]/)) {
            const clean = id.trim();
            if (known.has(clean) && !numbers.has(clean)) numbers.set(clean, numbers.size + 1);
        }
    }
    return numbers;
}

/** True when a citation still points at a place in the transcript the detail shows. */
export function hasPlace(citation: CitationPlace): boolean {
    return citation.segmentStart !== null || citation.line !== null;
}

/** A speaker id as the transcript shows it: "SPEAKER_00" reads as "Speaker 1". */
export function speakerName(id: string): string {
    const match = /^SPEAKER_(\d+)$/.exec(id);
    return match ? `Speaker ${Number(match[1]) + 1}` : id;
}
