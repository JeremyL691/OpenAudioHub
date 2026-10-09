import type { Env } from "../env";

export const DESKTOP_LAUNCH_SECRET_MIN_LENGTH = 32;

/**
 * Checks the settings that desktop mode depends on. Env validation calls this
 * only when OAH_DESKTOP=1 in a non-build runtime.
 */
export function validateDesktopEnv(
    parsed: Pick<Env, "APP_URL" | "OAH_DESKTOP_LAUNCH_SECRET">,
): void {
    const secret = parsed.OAH_DESKTOP_LAUNCH_SECRET;
    if (!secret || secret.length < DESKTOP_LAUNCH_SECRET_MIN_LENGTH) {
        throw new Error(
            `OAH_DESKTOP_LAUNCH_SECRET must be at least ${DESKTOP_LAUNCH_SECRET_MIN_LENGTH} characters when OAH_DESKTOP=1`,
        );
    }

    const appUrl = parsed.APP_URL ? new URL(parsed.APP_URL) : null;
    if (
        !appUrl ||
        appUrl.protocol !== "http:" ||
        appUrl.hostname !== "127.0.0.1"
    ) {
        throw new Error(
            "APP_URL must be http://127.0.0.1:<port> when OAH_DESKTOP=1",
        );
    }
}
