import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { ACTIVE_PIPELINE_STATUSES } from "@/db/queries/overview";
import {
    aiEnhancements,
    audioPipelineJobs,
    recordings,
    transcriptions,
} from "@/db/schema";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import {
    normalizeSource,
    OWN_SOURCE,
    OWN_SOURCE_VALUES,
} from "@/lib/transcription/source";

type IdContext = { params: Promise<{ id: string }> };

const DELETABLE_SOURCES: string[] = [OWN_SOURCE, "plaud", "mixed"];

// DELETE - Remove one transcript and the summary generated from it.
// `?source=` picks the transcript and defaults to this instance's own.
// The summary goes with it, because it was written from that transcript.
export const DELETE = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);

    const { id } = await (context as IdContext).params;
    const requested =
        new URL(request.url).searchParams.get("source") ?? OWN_SOURCE;
    const source = normalizeSource(requested);
    if (!DELETABLE_SOURCES.includes(source)) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Unknown transcript source",
            400,
        );
    }
    const sourceFilter =
        source === OWN_SOURCE
            ? inArray(transcriptions.source, OWN_SOURCE_VALUES)
            : eq(transcriptions.source, source);

    const [recording] = await db
        .select({ id: recordings.id })
        .from(recordings)
        .where(
            and(
                eq(recordings.id, id),
                eq(recordings.userId, session.user.id),
                isNull(recordings.deletedAt),
            ),
        )
        .limit(1);
    if (!recording) {
        throw new AppError(
            ErrorCode.RECORDING_NOT_FOUND,
            "Recording not found",
            404,
        );
    }

    const [job] = await db
        .select({ status: audioPipelineJobs.status })
        .from(audioPipelineJobs)
        .where(
            and(
                eq(audioPipelineJobs.recordingId, id),
                eq(audioPipelineJobs.userId, session.user.id),
            ),
        )
        .orderBy(desc(audioPipelineJobs.generation))
        .limit(1);
    if (
        job &&
        (ACTIVE_PIPELINE_STATUSES as readonly string[]).includes(job.status)
    ) {
        throw new AppError(
            ErrorCode.CONFLICT,
            "A transcription is still running for this recording",
            409,
        );
    }

    const removed = await db.transaction(async (tx) => {
        const rows = await tx
            .delete(transcriptions)
            .where(
                and(
                    eq(transcriptions.recordingId, id),
                    eq(transcriptions.userId, session.user.id),
                    sourceFilter,
                ),
            )
            .returning({ id: transcriptions.id });
        if (rows.length === 0) return false;

        await tx
            .delete(aiEnhancements)
            .where(
                and(
                    eq(aiEnhancements.recordingId, id),
                    eq(aiEnhancements.userId, session.user.id),
                ),
            );
        await tx
            .update(recordings)
            .set({ updatedAt: new Date() })
            .where(
                and(
                    eq(recordings.id, id),
                    eq(recordings.userId, session.user.id),
                    isNull(recordings.deletedAt),
                ),
            );
        return true;
    });
    if (!removed) {
        throw new AppError(ErrorCode.NOT_FOUND, "No transcript to delete", 404);
    }

    return NextResponse.json({ success: true });
});
