import { describe, expect, it } from "vitest";
import {
    buildTranscriptExport,
    formatSrtTime,
    formatVttTime,
    toSrt,
    toVtt,
    transcriptExportFilename,
} from "@/lib/transcript/export";

const timeline = [
    { start_ms: 0, end_ms: 4000, text: " Welcome to the weekly sync. " },
    { start_ms: 4000, end_ms: 9500, text: "Priya will share the roadmap." },
];

const input = {
    title: "Weekly team sync",
    language: "en",
    text: "Welcome to the weekly sync.",
    timeline,
};

describe("timestamps", () => {
    it("writes SRT times with a comma and VTT times with a dot", () => {
        expect(formatSrtTime(3_723_456)).toBe("01:02:03,456");
        expect(formatVttTime(3_723_456)).toBe("01:02:03.456");
    });

    it("clamps a negative time to zero", () => {
        expect(formatSrtTime(-5)).toBe("00:00:00,000");
    });
});

describe("cues", () => {
    it("writes numbered SRT cues separated by a blank line", () => {
        expect(toSrt(timeline)).toBe(
            "1\n00:00:00,000 --> 00:00:04,000\nWelcome to the weekly sync.\n\n2\n00:00:04,000 --> 00:00:09,500\nPriya will share the roadmap.\n",
        );
    });

    it("writes a WEBVTT header and cues with dot milliseconds", () => {
        expect(toVtt(timeline)).toBe(
            "WEBVTT\n\n00:00:00.000 --> 00:00:04.000\nWelcome to the weekly sync.\n\n00:00:04.000 --> 00:00:09.500\nPriya will share the roadmap.\n",
        );
    });
});

describe("buildTranscriptExport", () => {
    it("needs timestamps for SRT and VTT", () => {
        expect(
            buildTranscriptExport("srt", { ...input, timeline: null }),
        ).toBeNull();
        expect(
            buildTranscriptExport("vtt", { ...input, timeline: [] }),
        ).toBeNull();
    });

    it("exports TXT and JSON from the text alone", () => {
        const untimed = { ...input, timeline: null };
        expect(buildTranscriptExport("txt", untimed)?.content).toBe(
            "Welcome to the weekly sync.\n",
        );
        const json = JSON.parse(
            buildTranscriptExport("json", untimed)?.content ?? "{}",
        );
        expect(json).toEqual({
            title: "Weekly team sync",
            language: "en",
            text: "Welcome to the weekly sync.",
            segments: [],
        });
    });

    it("sets the MIME type and extension for each format", () => {
        expect(buildTranscriptExport("vtt", input)).toMatchObject({
            extension: "vtt",
            mimeType: "text/vtt",
        });
    });
});

describe("transcriptExportFilename", () => {
    it("keeps an ordinary title and replaces unsafe characters", () => {
        expect(transcriptExportFilename("Weekly team sync", "txt")).toBe(
            "Weekly team sync.txt",
        );
        expect(transcriptExportFilename("Plan: Q3/Q4?", "srt")).toBe(
            "Plan- Q3-Q4-.srt",
        );
    });

    it("falls back to a generic name for a blank title", () => {
        expect(transcriptExportFilename("   ", "json")).toBe("transcript.json");
    });
});
