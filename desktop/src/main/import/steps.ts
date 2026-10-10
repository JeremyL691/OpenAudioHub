/**
 * One part of a change that can be taken back. `run` does the work; `undo` puts back what `run` changed. A step
 * whose `run` throws must leave its own change undone, because `undo` is not called for it.
 */
export interface Step {
    name: string;
    run(): Promise<void> | void;
    undo(): Promise<void> | void;
}

/**
 * Runs the steps in order. When one throws, the steps that already completed are undone, last first, so a
 * failure part-way leaves the App as it was before the first step. A failing undo is logged and the rest still
 * run, because one stuck undo should not keep the others from putting back what they can. The original error is
 * rethrown: it is the one that says why the work stopped.
 */
export async function runSteps(
    steps: Step[],
    log: (message: string) => void,
): Promise<void> {
    const completed: Step[] = [];
    for (const step of steps) {
        try {
            await step.run();
        } catch (error) {
            for (const done of [...completed].reverse()) {
                try {
                    await done.undo();
                } catch (undoError) {
                    log(
                        `could not undo "${done.name}": ${messageOf(undoError)}`,
                    );
                }
            }
            throw error;
        }
        completed.push(step);
    }
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
