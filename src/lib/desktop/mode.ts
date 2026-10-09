import { env } from "../env";

/**
 * True when the server runs inside the macOS desktop shell (OAH_DESKTOP=1).
 * Every desktop-only branch in the app goes through this check, so Docker and
 * web self-host behaviour stays as it was when the variable is unset.
 */
export function isDesktopMode(): boolean {
    return env.OAH_DESKTOP === true;
}
