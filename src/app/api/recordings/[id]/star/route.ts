import { and, eq, isNull, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { recordings } from "@/db/schema";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";

type IdContext = { params: Promise<{ id: string }> };

/** Stars (`starred: true`) or unstars a recording the caller owns. */
export const PUT = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    const body = (await request.json().catch(() => ({}))) as unknown;
    if (
        body === null ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        typeof (body as { starred?: unknown }).starred !== "boolean"
    ) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "starred must be a boolean",
            400,
            { field: "starred" },
        );
    }

    const starred = (body as { starred: boolean }).starred;
    const now = new Date();

    // Keep the original star time when re-starring.
    const [updated] = await db
        .update(recordings)
        .set({
            starredAt: starred
                ? sql`coalesce(${recordings.starredAt}, now())`
                : null,
            updatedAt: now,
        })
        .where(
            and(
                eq(recordings.id, id),
                eq(recordings.userId, session.user.id),
                isNull(recordings.deletedAt),
            ),
        )
        .returning({ id: recordings.id });

    if (!updated) {
        throw new AppError(
            ErrorCode.RECORDING_NOT_FOUND,
            "Recording not found",
            404,
        );
    }

    return NextResponse.json({ id: updated.id, starred });
});
