import {
    and,
    count,
    countDistinct,
    desc,
    eq,
    inArray,
    isNotNull,
    isNull,
    sql,
} from "drizzle-orm";
import { db } from "@/db";
import {
    aiEnhancements,
    audioPipelineJobs,
    plaudConnections,
    recordings,
    transcriptions,
} from "@/db/schema";

/**
 * Pipeline job states that still need attention. Terminal states (completed,
 * failed, cancelled, needs_alignment) are left out.
 */
export const ACTIVE_PIPELINE_STATUSES = [
    "queued",
    "submitted",
    "running",
    "paused",
    "paused_disk",
] as const;

/**
 * Read models for the overview page. Every query filters by `userId`, and
 * soft-deleted recordings are excluded from the counts and the lists.
 */
export async function getOverviewTotals(userId: string) {
    const [totals] = await db
        .select({
            total: count(recordings.id),
            totalMs: sql<number>`coalesce(sum(${recordings.duration}), 0)`,
        })
        .from(recordings)
        .where(
            and(eq(recordings.userId, userId), isNull(recordings.deletedAt)),
        );

    const [transcribed] = await db
        .select({ n: countDistinct(transcriptions.recordingId) })
        .from(transcriptions)
        .innerJoin(recordings, eq(recordings.id, transcriptions.recordingId))
        .where(
            and(
                eq(transcriptions.userId, userId),
                isNull(recordings.deletedAt),
            ),
        );

    const [summarized] = await db
        .select({ n: countDistinct(aiEnhancements.recordingId) })
        .from(aiEnhancements)
        .innerJoin(recordings, eq(recordings.id, aiEnhancements.recordingId))
        .where(
            and(
                eq(aiEnhancements.userId, userId),
                isNotNull(aiEnhancements.summary),
                isNull(recordings.deletedAt),
            ),
        );

    return {
        total: Number(totals?.total ?? 0),
        totalMs: Number(totals?.totalMs ?? 0),
        transcribed: Number(transcribed?.n ?? 0),
        summarized: Number(summarized?.n ?? 0),
    };
}

export async function getActivePipelineJobs(userId: string, limit = 5) {
    return db
        .select({
            id: audioPipelineJobs.id,
            recordingId: audioPipelineJobs.recordingId,
            phase: audioPipelineJobs.phase,
            progress: audioPipelineJobs.progress,
            filename: recordings.filename,
        })
        .from(audioPipelineJobs)
        .innerJoin(recordings, eq(recordings.id, audioPipelineJobs.recordingId))
        .where(
            and(
                eq(audioPipelineJobs.userId, userId),
                inArray(audioPipelineJobs.status, [
                    ...ACTIVE_PIPELINE_STATUSES,
                ]),
                isNull(recordings.deletedAt),
            ),
        )
        .orderBy(desc(audioPipelineJobs.createdAt))
        .limit(limit);
}

export async function getRecentRecordings(userId: string, limit = 8) {
    return db
        .select({
            id: recordings.id,
            filename: recordings.filename,
            duration: recordings.duration,
            startTime: recordings.startTime,
            filesize: recordings.filesize,
            deviceSn: recordings.deviceSn,
        })
        .from(recordings)
        .where(and(eq(recordings.userId, userId), isNull(recordings.deletedAt)))
        .orderBy(desc(recordings.startTime))
        .limit(limit);
}

/** Which of the given recordings have a transcript and which have a summary. */
export async function getRecordingFlags(
    userId: string,
    recordingIds: string[],
) {
    if (recordingIds.length === 0) {
        return {
            transcribed: new Set<string>(),
            summarized: new Set<string>(),
        };
    }
    const [transcriptRows, summaryRows] = await Promise.all([
        db
            .select({ recordingId: transcriptions.recordingId })
            .from(transcriptions)
            .where(
                and(
                    eq(transcriptions.userId, userId),
                    inArray(transcriptions.recordingId, recordingIds),
                ),
            ),
        db
            .select({ recordingId: aiEnhancements.recordingId })
            .from(aiEnhancements)
            .where(
                and(
                    eq(aiEnhancements.userId, userId),
                    isNotNull(aiEnhancements.summary),
                    inArray(aiEnhancements.recordingId, recordingIds),
                ),
            ),
    ]);
    return {
        transcribed: new Set(transcriptRows.map((row) => row.recordingId)),
        summarized: new Set(summaryRows.map((row) => row.recordingId)),
    };
}

export interface PlaudStatus {
    connected: boolean;
    needsReconnect: boolean;
    email: string | null;
}

export async function getPlaudStatus(userId: string): Promise<PlaudStatus> {
    const [row] = await db
        .select({
            invalidatedAt: plaudConnections.invalidatedAt,
            plaudEmail: plaudConnections.plaudEmail,
        })
        .from(plaudConnections)
        .where(eq(plaudConnections.userId, userId))
        .limit(1);
    return {
        connected: row !== undefined,
        needsReconnect: row?.invalidatedAt != null,
        email: row?.plaudEmail ?? null,
    };
}
