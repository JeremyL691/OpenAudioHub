import { describe, expect, it } from "vitest";
import {
    pickTranscript,
    stitchTranscripts,
    type TranscriptPart,
} from "@/lib/recordings/merge-transcript";
import type { TimelineSegment } from "@/lib/transcription/audio-pipeline-repair";

const seg = (
    start_ms: number,
    end_ms: number,
    extra: Partial<TimelineSegment> = {},
): TimelineSegment => ({ start_ms, end_ms, text: `t${start_ms}`, ...extra });

describe("stitchTranscripts", () => {
    it("joins trimmed text and shifts timeline by offsets", () => {
        const parts: TranscriptPart[] = [
            { text: "  first  ", timeline: [seg(0, 1000)] },
            { text: "second\n", timeline: [seg(0, 500), seg(500, 900)] },
        ];
        const result = stitchTranscripts(parts, [0, 5000]);
        expect(result?.text).toBe("first\n\nsecond");
        expect(
            result?.timeline?.map(({ start_ms, end_ms }) => [start_ms, end_ms]),
        ).toEqual([
            [0, 1000],
            [5000, 5500],
            [5500, 5900],
        ]);
    });

    it("prefixes speaker ids per part and drops old chunk fields", () => {
        const parts: TranscriptPart[] = [
            {
                text: "a",
                timeline: [
                    seg(0, 100, {
                        speaker_id: "S1",
                        chunk_index: 2,
                        timestamp_source: "native",
                        timestamp_correction: {
                            reason: "chunk_end_guard",
                            original_end_ms: 100,
                            normalized_end_ms: 90,
                            chunk_index: 2,
                        },
                    }),
                ],
            },
            { text: "b", timeline: [seg(0, 100, { speaker_id: "S1" })] },
        ];
        const result = stitchTranscripts(parts, [0, 100]);
        expect(result?.timeline).toEqual([
            {
                start_ms: 0,
                end_ms: 100,
                text: "t0",
                speaker_id: "p1:S1",
                timestamp_source: "native",
            },
            { start_ms: 100, end_ms: 200, text: "t0", speaker_id: "p2:S1" },
        ]);
    });

    it("returns null when any part is null", () => {
        expect(
            stitchTranscripts([{ text: "a", timeline: null }, null], [0, 10]),
        ).toBeNull();
    });

    it("keeps text but nulls timeline when one timeline is missing or empty", () => {
        const missing = stitchTranscripts(
            [
                { text: "a", timeline: [seg(0, 10)] },
                { text: "b", timeline: null },
            ],
            [0, 10],
        );
        expect(missing).toEqual({ text: "a\n\nb", timeline: null });

        const empty = stitchTranscripts(
            [
                { text: "a", timeline: [] },
                { text: "b", timeline: [seg(0, 10)] },
            ],
            [0, 10],
        );
        expect(empty).toEqual({ text: "a\n\nb", timeline: null });
    });

    it("throws on length mismatch", () => {
        expect(() =>
            stitchTranscripts([{ text: "a", timeline: null }], [0, 10]),
        ).toThrow(Error);
    });

    it("does not mutate inputs", () => {
        const parts: TranscriptPart[] = [
            {
                text: " a ",
                timeline: [seg(0, 10, { speaker_id: "S1", chunk_index: 0 })],
            },
        ];
        const snapshot = structuredClone(parts);
        stitchTranscripts(parts, [1000]);
        expect(parts).toEqual(snapshot);
    });
});

describe("pickTranscript", () => {
    const row = (source: string, day: number) => ({
        source,
        createdAt: new Date(2026, 0, day),
        id: `${source}-${day}`,
    });

    it("prefers the preferred source over newer rows", () => {
        const rows = [
            row("plaud", 5),
            row("openaudiohub", 1),
            row("openaudiohub", 3),
        ];
        expect(pickTranscript(rows, "openaudiohub")?.id).toBe("openaudiohub-3");
    });

    it("falls back to the newest other source", () => {
        const rows = [row("plaud", 1), row("mixed", 4), row("plaud", 2)];
        expect(pickTranscript(rows, "openaudiohub")?.id).toBe("mixed-4");
    });

    it("returns null for no rows", () => {
        expect(pickTranscript([], "openaudiohub")).toBeNull();
    });
});
