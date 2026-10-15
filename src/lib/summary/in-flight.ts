import type { GenerateSummaryResult } from "./generate-summary";

/**
 * Manual summaries that are still being generated, keyed by user and
 * recording. The page that started one can be left or reloaded (or the
 * desktop window closed) while the server keeps working, so GET reports
 * the run and a second POST joins it instead of starting another.
 *
 * shortcut: in-process memory, so it covers one server process (the desktop
 * app and single-container installs); move it to the database if summaries
 * ever run across several app processes.
 */
const running = new Map<string, Promise<GenerateSummaryResult>>();

const keyFor = (userId: string, recordingId: string) =>
    `${userId}:${recordingId}`;

export function isSummaryRunning(userId: string, recordingId: string): boolean {
    return running.has(keyFor(userId, recordingId));
}

/** Runs `start` unless a summary for this recording is already running, in which case its result is shared. */
export function runSummaryOnce(
    userId: string,
    recordingId: string,
    start: () => Promise<GenerateSummaryResult>,
): Promise<GenerateSummaryResult> {
    const key = keyFor(userId, recordingId);
    const existing = running.get(key);
    if (existing) return existing;
    const run = start().finally(() => running.delete(key));
    running.set(key, run);
    return run;
}
