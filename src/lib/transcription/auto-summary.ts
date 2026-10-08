import { eq } from "drizzle-orm";
import { db } from "@/db";
import { userSettings } from "@/db/schema";
import { env } from "@/lib/env";
import { consumeRateLimitBucket } from "@/lib/rate-limit";
import { generateSummaryForRecording } from "@/lib/summary/generate-summary";
import { emitEvent } from "@/lib/webhooks/emit";

/** Which path committed the transcript. Only changes log lines. */
export type AutoSummaryTrigger = "direct" | "pipeline";

export interface AutoSummarySettings {
    autoSummarize: boolean;
    autoSummarizePreset: string | null;
}

async function loadAutoSummarySettings(
    userId: string,
): Promise<AutoSummarySettings> {
    const [row] = await db
        .select({
            autoSummarize: userSettings.autoSummarize,
            autoSummarizePreset: userSettings.autoSummarizePreset,
        })
        .from(userSettings)
        .where(eq(userSettings.userId, userId))
        .limit(1);
    return {
        autoSummarize: row?.autoSummarize ?? false,
        autoSummarizePreset: row?.autoSummarizePreset ?? null,
    };
}

/**
 * Creates the automatic summary once a transcript is committed. It does
 * nothing unless the user's auto-summarize setting is on. It is capped per
 * user per hour, and a failure here never rolls back the transcript: it
 * emits `summary.failed` and returns.
 *
 * Callers that already hold the user's settings pass them, so the database
 * is not read twice. The audio pipeline does not, and reads them here.
 */
export async function maybeAutoSummarize(
    recordingId: string,
    userId: string,
    trigger: AutoSummaryTrigger,
    settings?: AutoSummarySettings,
): Promise<void> {
    const current = settings ?? (await loadAutoSummarySettings(userId));
    if (!current.autoSummarize) return;

    const origin = trigger === "pipeline" ? " from the audio pipeline" : "";

    // Per-user hourly cap on auto-summary calls. Cheap defense
    // against runaway provider cost if a sync replays N
    // recordings or the user toggles auto-summarize on with an
    // expensive model. The manual "Generate summary" button is
    // not throttled -- the user is in the loop there.
    const rateLimit = await consumeRateLimitBucket(
        `auto-summary:user:${userId}`,
        {
            limit: env.AUTO_SUMMARY_RATE_LIMIT_PER_HOUR,
            windowMs: 60 * 60 * 1000,
        },
    );

    if (!rateLimit.allowed) {
        console.warn(
            `Auto-summary rate limit hit for user ${userId} (recording ${recordingId})${origin}`,
        );
        await emitEvent("summary.failed", userId, recordingId, {
            error: `Auto-summary rate limit exceeded (${env.AUTO_SUMMARY_RATE_LIMIT_PER_HOUR}/hour). Manual summary still works.`,
        });
        return;
    }

    // Run summarization synchronously so the `summary.completed`
    // event (and the underlying summary write) lands before
    // downstream consumers that listen for it. A failure here
    // must not roll back the transcript itself -- the user
    // still wants the transcript even if the summary call dies.
    try {
        await generateSummaryForRecording(userId, recordingId, {
            presetId: current.autoSummarizePreset ?? undefined,
            trigger: "auto",
        });
        await emitEvent("summary.completed", userId, recordingId);
    } catch (error) {
        console.error(
            `Auto-summarize failed for recording ${recordingId}${origin}:`,
            error,
        );
        await emitEvent("summary.failed", userId, recordingId, {
            error: error instanceof Error ? error.message : String(error),
        });
    }
}
