import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isDesktopMode } from "@/lib/desktop/mode";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

/** Compares SHA-256 digests so the comparison takes the same time for any input length. */
function matchesSecret(presented: string, expected: string): boolean {
    const a = createHash("sha256").update(presented).digest();
    const b = createHash("sha256").update(expected).digest();
    return timingSafeEqual(a, b);
}

/**
 * Exchanges the desktop launch secret for a session cookie. The Electron main
 * process calls this with `Authorization: Bearer <secret>` and stores the
 * returned cookie in its own partition. Outside desktop mode the route does not exist.
 */
export async function POST(request: Request) {
    if (!isDesktopMode()) {
        return new NextResponse(null, { status: 404 });
    }

    const expectedHost = env.APP_URL ? new URL(env.APP_URL).host : "";
    if (request.headers.get("host") !== expectedHost) {
        return new NextResponse(null, { status: 403 });
    }

    const presented =
        request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1] ?? "";
    const expected = env.OAH_DESKTOP_LAUNCH_SECRET ?? "";
    if (!expected || !matchesSecret(presented, expected)) {
        return new NextResponse(null, { status: 401 });
    }

    let response: Response;
    try {
        response = await auth.api.desktopSession({ asResponse: true });
    } catch (error) {
        console.error(
            "[desktop] session exchange failed:",
            error instanceof Error ? error.message : "unknown error",
        );
        return new NextResponse(null, { status: 500 });
    }
    if (!response.ok) {
        return new NextResponse(null, { status: 500 });
    }

    const result = new NextResponse(null, { status: 204 });
    for (const cookie of response.headers.getSetCookie()) {
        result.headers.append("set-cookie", cookie);
    }
    return result;
}
