import { NextResponse } from "next/server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { connectPlaudWithToken } from "@/lib/plaud/connect-with-token";
import {
    getHandoff,
    markHandoffConnected,
    markHandoffError,
} from "@/lib/plaud/handoff-store";

const HANDOFF_EXPIRED_MESSAGE =
    "This sign-in link has expired. Start again from the OpenAudioHub app.";

/**
 * POST /api/plaud/auth/handoff/complete
 *
 * Called by the browser handoff page on the app origin, with no session. The
 * one-time code in the body authorizes the connection. Requires
 * `sec-fetch-site: same-origin` as a CSRF guard.
 */
export const POST = apiHandler(async (request: Request) => {
    if (request.headers.get("sec-fetch-site") !== "same-origin") {
        throw new AppError(
            ErrorCode.FORBIDDEN,
            "Cross-site requests are not allowed",
            403,
        );
    }

    const body = (await request.json().catch(() => null)) as {
        code?: unknown;
        accessToken?: unknown;
        apiBase?: unknown;
    } | null;

    const code = typeof body?.code === "string" ? body.code : "";
    const entry = code ? getHandoff(code) : undefined;
    if (!entry || entry.status === "connected") {
        throw new AppError(
            ErrorCode.PLAUD_HANDOFF_EXPIRED,
            HANDOFF_EXPIRED_MESSAGE,
            410,
        );
    }

    if (typeof body?.accessToken !== "string" || !body.accessToken.trim()) {
        throw new AppError(
            ErrorCode.MISSING_REQUIRED_FIELD,
            "accessToken is required",
            400,
            { field: "accessToken" },
        );
    }

    try {
        await connectPlaudWithToken({
            userId: entry.userId,
            accessToken: body.accessToken,
            apiBase: body.apiBase,
            source: "connector",
        });
    } catch (err) {
        if (err instanceof AppError) {
            markHandoffError(code, err.message);
        }
        throw err;
    }

    markHandoffConnected(code);
    return NextResponse.json({ success: true });
});
