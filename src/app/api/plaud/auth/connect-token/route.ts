import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { connectPlaudWithToken } from "@/lib/plaud/connect-with-token";

/**
 * POST /api/plaud/auth/connect-token
 *
 * Connect a Plaud account by submitting an existing access token, bypassing
 * the OTP flow. Validation and persistence live in `connectPlaudWithToken`.
 *
 * Source: https://github.com/JeremyL691/OpenAudioHub/blob/main/src/app/api/plaud/auth/connect-token/route.ts
 */
export const POST = apiHandler(async (request: Request) => {
    const session = await requireApiSession(request);

    const body = (await request.json().catch(() => null)) as {
        accessToken?: unknown;
        apiBase?: unknown;
        source?: unknown;
    } | null;

    if (!body || typeof body.accessToken !== "string") {
        throw new AppError(
            ErrorCode.MISSING_REQUIRED_FIELD,
            "accessToken is required",
            400,
            { field: "accessToken" },
        );
    }

    const { devices } = await connectPlaudWithToken({
        userId: session.user.id,
        accessToken: body.accessToken,
        apiBase: body.apiBase,
        source: body.source,
    });

    return NextResponse.json({
        success: true,
        devices,
    });
});
