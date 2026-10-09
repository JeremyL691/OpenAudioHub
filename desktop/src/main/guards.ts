import { basename } from "node:path";

/** Paths that show a sign-in or landing page. The desktop app never shows them; it re-exchanges the session instead. */
const AUTH_PATHS = new Set([
    "/",
    "/login",
    "/register",
    "/forgot-password",
    "/reset-password",
    "/request-password-reset",
]);

/** Same scheme, host and port as the app origin, e.g. http://127.0.0.1:38400. */
export function isAppUrl(url: string, appOrigin: string): boolean {
    try {
        return new URL(url).origin === new URL(appOrigin).origin;
    } catch {
        return false;
    }
}

/** True when navigating to `url` should re-exchange the session first (sign-in pages, the landing page). */
export function needsSessionExchange(url: string, appOrigin: string): boolean {
    if (!isAppUrl(url, appOrigin)) return false;
    const { pathname } = new URL(url);
    return AUTH_PATHS.has(pathname.replace(/\/+$/, "") || "/");
}

/** External links open in the default browser, and only for http and https. */
export function isOpenableExternally(url: string): boolean {
    try {
        const protocol = new URL(url).protocol;
        return protocol === "http:" || protocol === "https:";
    } catch {
        return false;
    }
}

/** The renderer is granted notifications only (PLAN D-320). Every other permission is denied. */
export function isPermissionGranted(permission: string): boolean {
    return permission === "notifications";
}

/**
 * A safe file name for a download: no directory parts, no control characters, no leading dots,
 * and a fallback when nothing usable remains.
 */
export function safeDownloadName(suggested: string): string {
    const base = basename(suggested.replace(/\\/g, "/"))
        // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point here
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .replace(/^\.+/, "")
        .trim();
    return base.length > 0 ? base.slice(0, 200) : "download";
}
