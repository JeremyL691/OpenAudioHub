import { describe, expect, it } from "vitest";
import { uniqueArchiveName } from "@/lib/recordings/download-audio";
import {
    buildDownloadFilename,
    dateRecordingTitle,
} from "@/lib/recordings/filename";

describe("dateRecordingTitle", () => {
    it("formats the local date as YYYY-MM-DD", () => {
        expect(dateRecordingTitle(new Date(2026, 0, 5, 23, 59))).toBe(
            "2026-01-05",
        );
    });
});

describe("uniqueArchiveName", () => {
    it("suffixes repeated names, ignoring case", () => {
        const used = new Set<string>();
        expect(uniqueArchiveName("2026-10-12.mp3", used)).toBe(
            "2026-10-12.mp3",
        );
        expect(uniqueArchiveName("2026-10-12.mp3", used)).toBe(
            "2026-10-12 (2).mp3",
        );
        expect(uniqueArchiveName("2026-10-12.MP3", used)).toBe(
            "2026-10-12 (3).MP3",
        );
    });
});

describe("buildDownloadFilename with an explicit extension", () => {
    it("uses the given extension instead of the stored one", () => {
        expect(buildDownloadFilename("Call", "u/a.ogg", "id", "mp3")).toBe(
            "Call.mp3",
        );
    });
});
