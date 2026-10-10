import { describe, expect, it } from "vitest";
import { runSteps, type Step } from "../src/main/import/steps.js";

/** A step that records its run and undo in `trace`; `failRun` or `failUndo` make it throw. */
function step(
    name: string,
    trace: string[],
    options: { failRun?: Error; failUndo?: Error } = {},
): Step {
    return {
        name,
        run: () => {
            trace.push(`run ${name}`);
            if (options.failRun) throw options.failRun;
        },
        undo: () => {
            trace.push(`undo ${name}`);
            if (options.failUndo) throw options.failUndo;
        },
    };
}

describe("runSteps", () => {
    it("runs every step in order and undoes none when all succeed", async () => {
        const trace: string[] = [];
        const logs: string[] = [];

        await runSteps(
            [step("one", trace), step("two", trace), step("three", trace)],
            (message) => logs.push(message),
        );

        expect(trace).toEqual(["run one", "run two", "run three"]);
        expect(logs).toEqual([]);
    });

    it("undoes the completed steps in reverse order when a later step fails, and rethrows the original error", async () => {
        const trace: string[] = [];
        const original = new Error("disk full");

        await expect(
            runSteps(
                [
                    step("one", trace),
                    step("two", trace),
                    step("three", trace, { failRun: original }),
                    step("four", trace),
                ],
                () => undefined,
            ),
        ).rejects.toBe(original);

        expect(trace).toEqual([
            "run one",
            "run two",
            "run three",
            "undo two",
            "undo one",
        ]);
    });

    it("logs a failing undo with the step name and keeps undoing the rest", async () => {
        const trace: string[] = [];
        const logs: string[] = [];
        const original = new Error("switch failed");

        await expect(
            runSteps(
                [
                    step("one", trace),
                    step("two", trace, {
                        failUndo: new Error("rename refused"),
                    }),
                    step("three", trace, { failRun: original }),
                ],
                (message) => logs.push(message),
            ),
        ).rejects.toBe(original);

        expect(trace).toEqual([
            "run one",
            "run two",
            "run three",
            "undo two",
            "undo one",
        ]);
        expect(logs).toEqual(['could not undo "two": rename refused']);
    });
});
