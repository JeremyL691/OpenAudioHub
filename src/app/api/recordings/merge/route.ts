import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { mergeRecordings } from "@/lib/recordings/merge";

const MAX_IDS = 100;
const RECORDING_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TITLE_LENGTH = 255;

/**
 * POST /api/recordings/merge  { ids: string[], title?: string }
 *
 * Concatenates the recordings in the given order into one new recording and
 * answers `201 { id }`. The originals are kept; the client deletes them when
 * the user asks for that.
 */
export const POST = apiHandler(async (request: Request) => {
    const session = await requireApiSession(request);
    const body = (await request.json().catch(() => null)) as {
        ids?: unknown;
        title?: unknown;
    } | null;
    const ids = body?.ids;
    if (
        !Array.isArray(ids) ||
        ids.length < 2 ||
        ids.length > MAX_IDS ||
        !ids.every((id) => typeof id === "string" && RECORDING_ID.test(id)) ||
        new Set(ids).size !== ids.length
    ) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            `ids must be 2 to ${MAX_IDS} distinct recording ids`,
            400,
        );
    }
    const title = body?.title;
    if (
        title !== undefined &&
        (typeof title !== "string" || title.trim().length > MAX_TITLE_LENGTH)
    ) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            `title must be at most ${MAX_TITLE_LENGTH} characters`,
            400,
        );
    }

    const id = await mergeRecordings(session.user.id, ids, title);
    return NextResponse.json({ id }, { status: 201 });
});
