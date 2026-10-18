import type { Site } from "./token";

export type { Site } from "./token";

export const PAGE_APP = "openaudiohub-extension";
export const PROTOCOL = 1;
export const CONNECT_META = "openaudiohub-plaud-connect";

export const SITE_URLS: Record<Site, string> = {
    global: "https://web.plaud.ai/",
    cn: "https://web.plaud.cn/",
};

export type FailureReason = "timeout" | "cancelled" | "replaced" | "page-gone";

export type PageMessage =
    | { app: typeof PAGE_APP; protocol: typeof PROTOCOL; kind: "waiting"; site: Site }
    | {
          app: typeof PAGE_APP;
          protocol: typeof PROTOCOL;
          kind: "token";
          accessToken: string;
          apiBase: string;
      }
    | { app: typeof PAGE_APP; protocol: typeof PROTOCOL; kind: "failed"; reason: FailureReason };

export const FAILURE_TEXT: Record<FailureReason, string> = {
    timeout: "Plaud sign-in timed out after 5 minutes. Click the OpenAudioHub icon to try again.",
    cancelled: "Sign-in was cancelled. Click the OpenAudioHub icon to try again.",
    replaced: "Another Plaud sign-in started in this browser.",
    "page-gone": "The OpenAudioHub page was closed or reloaded. Start again from that page.",
};

/** The connect page URL, or `null` when the URL is not a connect page. */
export function connectPageFromUrl(raw: string | undefined): URL | null {
    if (!raw) return null;
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return null;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.pathname !== "/connect/plaud") return null;
    const code = url.searchParams.get("code");
    if (code === null || code.trim() === "") return null;
    return url;
}

export function waitingMessage(site: Site): PageMessage {
    return { app: PAGE_APP, protocol: PROTOCOL, kind: "waiting", site };
}

export function tokenMessage(accessToken: string, apiBase: string): PageMessage {
    return { app: PAGE_APP, protocol: PROTOCOL, kind: "token", accessToken, apiBase };
}

export function failedMessage(reason: FailureReason): PageMessage {
    return { app: PAGE_APP, protocol: PROTOCOL, kind: "failed", reason };
}
