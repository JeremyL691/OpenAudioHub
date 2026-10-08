import { describe, expect, it } from "vitest";
import {
    pipelinePhaseStatus,
    transcriptStatus,
} from "@/lib/recordings/transcript-status";

describe("transcriptStatus", () => {
    it("ranks summary over transcript over missing", () => {
        expect(
            transcriptStatus({ hasSummary: true, hasTranscript: true }),
        ).toBe("summary_ready");
        expect(transcriptStatus({ hasTranscript: true })).toBe(
            "transcript_ready",
        );
        expect(transcriptStatus({})).toBe("transcript_missing");
    });

    it("shows an active pipeline phase before the content state", () => {
        // A long recording in the server pipeline used to read "Not transcribed"
        // in the library while the overview showed it transcribing (D-203).
        expect(transcriptStatus({ pipelinePhase: "transcribing" })).toBe(
            "transcribing",
        );
        expect(
            transcriptStatus({ hasTranscript: true, pipelinePhase: "vad" }),
        ).toBe("vad");
        expect(
            transcriptStatus({ hasTranscript: true, pipelinePhase: null }),
        ).toBe("transcript_ready");
    });
});

describe("pipelinePhaseStatus", () => {
    it("passes known phases through and reads unknown ones as running", () => {
        expect(pipelinePhaseStatus("paused_disk")).toBe("paused_disk");
        expect(pipelinePhaseStatus("some_future_phase")).toBe("running");
    });
});
