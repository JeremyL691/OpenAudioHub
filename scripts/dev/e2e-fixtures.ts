// Deterministic E2E content shared by the seed script and the fake AI server.
// Segment times are in seconds (transcription output); timelines use milliseconds.

export interface FixtureSegment {
    start: number;
    end: number;
    text: string;
}

export const SHORT_SEGMENTS: FixtureSegment[] = [
    { start: 0, end: 4, text: "Welcome to the weekly sync." },
    { start: 4, end: 9, text: "Priya will share the roadmap update." },
    {
        start: 9,
        end: 15,
        text: "The audio pipeline now handles long recordings.",
    },
    { start: 15, end: 22, text: "Action item: review the timeline on Friday." },
];

export const LONG_SEGMENTS: FixtureSegment[] = Array.from(
    { length: 40 },
    (_, index) => ({
        start: index * 15,
        end: index * 15 + 15,
        text: `Segment ${index + 1} of the long lecture covers topic ${(index % 5) + 1}.`,
    }),
);

export const SUMMARY = {
    summary:
        "The team reviewed the roadmap and agreed on a timeline review for Friday.",
    keyPoints: [
        "Roadmap update from Priya",
        "Long recordings are handled by the audio pipeline",
    ],
    actionItems: ["Review the timeline on Friday"],
};

export function joinSegmentText(segments: FixtureSegment[]): string {
    return segments.map((segment) => segment.text).join(" ");
}

export function toTimeline(segments: FixtureSegment[]) {
    return segments.map((segment) => ({
        start_ms: segment.start * 1000,
        end_ms: segment.end * 1000,
        text: segment.text,
    }));
}
