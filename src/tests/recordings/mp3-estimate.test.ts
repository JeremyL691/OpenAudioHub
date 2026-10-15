import { describe, expect, it } from "vitest";
import {
    DOWNLOAD_MP3_KBPS,
    estimateMp3Bytes,
} from "@/lib/recordings/mp3-estimate";

describe("estimateMp3Bytes", () => {
    it("uses the download MP3 bitrate", () => {
        expect(DOWNLOAD_MP3_KBPS).toBe(128);
    });

    it("estimates 128 kbps: one minute is 960 KB", () => {
        expect(estimateMp3Bytes(60_000)).toBe(960_000);
    });

    it("returns 0 for empty, negative or non-finite durations", () => {
        expect(estimateMp3Bytes(0)).toBe(0);
        expect(estimateMp3Bytes(-5_000)).toBe(0);
        expect(estimateMp3Bytes(Number.NaN)).toBe(0);
    });
});
