import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import {
    createHandoff,
    deleteHandoff,
    getHandoff,
} from "@/lib/plaud/handoff-store";

/**
 * POST /api/plaud/auth/handoff
 *
 * Create a one-time code that the browser handoff page uses to deliver a
 * Plaud token back to this user's account.
 */
export const POST = apiHandler(async (request: Request) => {
    const session = await requireApiSession(request);
    const { code, expiresAt } = createHandoff(session.user.id);
    return NextResponse.json({ code, expiresAt });
});

/**
 * GET /api/plaud/auth/handoff?code=
 *
 * Report a handoff's status to its owner. Codes that belong to another user
 * report "expired", so existence is not leaked.
 */
export const GET = apiHandler(async (request: Request) => {
    const session = await requireApiSession(request);
    const code = readCode(request);

    const entry = getHandoff(code);
    if (!entry || entry.userId !== session.user.id) {
        return NextResponse.json({ status: "expired" });
    }

    return NextResponse.json({
        status: entry.status,
        ...(entry.error !== undefined && { error: entry.error }),
    });
});

/**
 * DELETE /api/plaud/auth/handoff?code=
 *
 * Cancel a handoff owned by the caller. Deleting a code the caller does not
 * own succeeds without effect.
 */
export const DELETE = apiHandler(async (request: Request) => {
    const session = await requireApiSession(request);
    const code = readCode(request);

    const entry = getHandoff(code);
    if (entry?.userId === session.user.id) {
        deleteHandoff(code);
    }

    return NextResponse.json({ success: true });
});

function readCode(request: Request): string {
    const code = new URL(request.url).searchParams.get("code")?.trim() ?? "";
    if (!code) {
        throw new AppError(
            ErrorCode.MISSING_REQUIRED_FIELD,
            "code is required",
            400,
            { field: "code" },
        );
    }
    return code;
}
