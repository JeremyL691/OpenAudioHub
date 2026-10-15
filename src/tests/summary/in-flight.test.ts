import { describe, expect, it } from "vitest";
import type { GenerateSummaryResult } from "@/lib/summary/generate-summary";
import { isSummaryRunning, runSummaryOnce } from "@/lib/summary/in-flight";

const result = { summary: "s" } as GenerateSummaryResult;

describe("runSummaryOnce", () => {
    it("shares one run per recording and forgets it once it settles", async () => {
        let finish!: (value: GenerateSummaryResult) => void;
        let starts = 0;
        const start = () => {
            starts += 1;
            return new Promise<GenerateSummaryResult>((resolve) => {
                finish = resolve;
            });
        };
        const first = runSummaryOnce("u1", "r1", start);
        const second = runSummaryOnce("u1", "r1", start);
        expect(starts).toBe(1);
        expect(isSummaryRunning("u1", "r1")).toBe(true);
        expect(isSummaryRunning("u2", "r1")).toBe(false);

        finish(result);
        await expect(first).resolves.toBe(result);
        await expect(second).resolves.toBe(result);
        expect(isSummaryRunning("u1", "r1")).toBe(false);
    });

    it("forgets a failed run so the next POST starts again", async () => {
        await expect(
            runSummaryOnce("u1", "r2", () => Promise.reject(new Error("x"))),
        ).rejects.toThrow("x");
        expect(isSummaryRunning("u1", "r2")).toBe(false);
    });
});
