import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import {
    DESKTOP_USER_EMAIL,
    DESKTOP_USER_NAME,
    resolveDesktopUserId,
} from "./local-user";

/**
 * Server-only better-auth endpoint that signs the desktop window in. It is not
 * reachable through `/api/auth/*`; the `/api/desktop/session` route calls it
 * after checking the launch secret and the Host header.
 */
export const desktopSessionPlugin = () =>
    ({
        id: "desktop-session",
        endpoints: {
            desktopSession: createAuthEndpoint.serverOnly(
                { method: "POST" },
                async (ctx) => {
                    const userId = await resolveDesktopUserId(() =>
                        ctx.context.internalAdapter.createUser({
                            email: DESKTOP_USER_EMAIL,
                            name: DESKTOP_USER_NAME,
                            emailVerified: true,
                        }),
                    );
                    const user =
                        await ctx.context.internalAdapter.findUserById(userId);
                    if (!user) {
                        throw new APIError("NOT_FOUND", {
                            message: "Desktop user not found",
                        });
                    }
                    const session =
                        await ctx.context.internalAdapter.createSession(
                            user.id,
                        );
                    await setSessionCookie(ctx, { session, user });
                    return ctx.json({ ok: true });
                },
            ),
        },
    }) satisfies BetterAuthPlugin;
