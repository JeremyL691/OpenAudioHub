import { describe, expect, it } from "vitest";
import {
    joinPartNotes,
    partTimeRanges,
    splitTranscript,
} from "@/lib/summary/chunking";

describe("splitTranscript", () => {
    it("keeps a short transcript whole", () => {
        expect(splitTranscript("Speaker 1: hi", 100)).toEqual([
            "Speaker 1: hi",
        ]);
    });

    it("splits on line ends, keeps order, and never exceeds the budget", () => {
        const lines = Array.from(
            { length: 50 },
            (_, i) => `Speaker 1: line ${i}`,
        );
        const parts = splitTranscript(lines.join("\n"), 120);
        expect(parts.length).toBeGreaterThan(1);
        for (const part of parts) expect(part.length).toBeLessThanOrEqual(120);
        expect(parts.join("\n")).toBe(lines.join("\n"));
    });

    it("splits one long line at sentence ends, then hard-cuts", () => {
        const line = "今天讨论预算。".repeat(30);
        const parts = splitTranscript(line, 50);
        for (const part of parts) {
            expect(part.length).toBeLessThanOrEqual(50);
            expect(part.endsWith("。")).toBe(true);
        }
        expect(parts.join("")).toBe(line);
        const noPunctuation = "x".repeat(130);
        expect(splitTranscript(noPunctuation, 50).map((p) => p.length)).toEqual(
            [50, 50, 30],
        );
    });
});

describe("partTimeRanges", () => {
    it("spreads the duration over the parts by length", () => {
        const ranges = partTimeRanges(
            ["a".repeat(100), "b".repeat(300)],
            4 * 3600_000,
        );
        expect(ranges).toEqual([
            { start: "0:00", end: "1:00:00" },
            { start: "1:00:00", end: "4:00:00" },
        ]);
        expect(joinPartNotes(["n1", "n2"], ranges)).toContain(
            "### Part 2 (about 1:00:00 to 4:00:00)\nn2",
        );
    });
});
