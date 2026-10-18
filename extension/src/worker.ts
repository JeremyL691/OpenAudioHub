import {
    TIMEOUT_ALARM,
    clearFlow,
    deliver,
    focusTab,
    readFlow,
    rememberResult,
    writeFlow,
    type FlowState,
    type LastResult,
} from "./flow";
import { SITE_URLS, failedMessage, tokenMessage, waitingMessage, type FailureReason } from "./protocol";
import { acceptToken, type AcceptedToken, type Site } from "./token";

const FIVE_MINUTES = 5 * 60_000;
const PLAUD_COOKIE = "pld_ut";

interface StartMessage {
    type: "start";
    tabId: number;
    origin: string;
    site: Site;
    timeoutMs?: number;
}

interface CancelMessage {
    type: "cancel";
}

type IncomingMessage = StartMessage | CancelMessage;

/** Runs the handlers one at a time so two events cannot finish the same flow twice. */
let pending: Promise<unknown> = Promise.resolve();

function serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = pending.then(task, task);
    pending = run.then(
        () => undefined,
        () => undefined,
    );
    return run;
}

function parseOrigin(value: string): string | null {
    try {
        const url = new URL(value);
        if (url.protocol !== "http:" && url.protocol !== "https:") return null;
        return url.origin === value ? value : null;
    } catch {
        return null;
    }
}

function isStartMessage(message: unknown): message is StartMessage {
    if (typeof message !== "object" || message === null) return false;
    const candidate = message as Record<string, unknown>;
    return (
        candidate.type === "start" &&
        typeof candidate.tabId === "number" &&
        Number.isInteger(candidate.tabId) &&
        typeof candidate.origin === "string" &&
        (candidate.site === "global" || candidate.site === "cn")
    );
}

function isCancelMessage(message: unknown): message is CancelMessage {
    return typeof message === "object" && message !== null && (message as Record<string, unknown>).type === "cancel";
}

/** Accepts a raw value and applies the test API base in the test build. */
function accept(raw: string, site: Site): AcceptedToken | null {
    const accepted = acceptToken(raw, site);
    if (accepted === null) return null;
    if (__OAH_TEST__) return { ...accepted, apiBase: __OAH_TEST_API_BASE__ };
    return accepted;
}

async function readCookie(site: Site): Promise<string | null> {
    const name = PLAUD_COOKIE;
    try {
        const cookie = await chrome.cookies.get({ url: SITE_URLS[site], name });
        return cookie?.value ?? null;
    } catch {
        return null;
    }
}

async function readLocalToken(tabId: number): Promise<string | null> {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
                try {
                    return window.localStorage.getItem("pld_tokenstr");
                } catch {
                    return null;
                }
            },
        });
        const value = results[0]?.result;
        return typeof value === "string" ? value : null;
    } catch {
        return null;
    }
}

function domainMatches(domain: string | undefined, site: Site): boolean {
    if (domain === undefined) return false;
    const suffix = site === "cn" ? "plaud.cn" : "plaud.ai";
    return domain === suffix || domain.endsWith(`.${suffix}`);
}

async function finish(result: LastResult): Promise<void> {
    await clearFlow();
    await chrome.alarms.clear(TIMEOUT_ALARM);
    await rememberResult(result);
}

async function fail(flow: FlowState, reason: FailureReason, notifyPage: boolean): Promise<void> {
    if (notifyPage) await deliver(flow, failedMessage(reason));
    await finish({ ok: false, reason });
}

async function deliverToken(flow: FlowState, accepted: AcceptedToken): Promise<void> {
    const delivered = await deliver(flow, tokenMessage(accepted.accessToken, accepted.apiBase));
    if (!delivered) {
        await finish({ ok: false, reason: "page-gone" });
        return;
    }
    if (flow.plaudTabId !== undefined) {
        try {
            await chrome.tabs.remove(flow.plaudTabId);
        } catch {
            // The user may have closed the Plaud tab already.
        }
    }
    await focusTab(flow.tabId);
    await finish({ ok: true });
}

async function checkPlaudTab(flow: FlowState, tabId: number): Promise<void> {
    const cookie = await readCookie(flow.site);
    if (cookie !== null) {
        const accepted = accept(cookie, flow.site);
        if (accepted !== null) {
            await deliverToken(flow, accepted);
            return;
        }
    }
    const stored = await readLocalToken(tabId);
    if (stored !== null) {
        const accepted = accept(stored, flow.site);
        if (accepted !== null) await deliverToken(flow, accepted);
    }
}

async function startFlow(message: StartMessage): Promise<void> {
    const origin = parseOrigin(message.origin);
    if (origin === null) return;
    const site: Site = message.site;

    const previous = await readFlow();
    if (previous !== null) {
        await deliver(previous, failedMessage("replaced"));
        await clearFlow();
    }

    const flow: FlowState = { tabId: message.tabId, origin, site, startedAt: Date.now() };
    await writeFlow(flow);
    const duration =
        __OAH_TEST__ && typeof message.timeoutMs === "number" && message.timeoutMs > 0
            ? message.timeoutMs
            : FIVE_MINUTES;
    await chrome.alarms.create(TIMEOUT_ALARM, { when: Date.now() + duration });

    const delivered = await deliver(flow, waitingMessage(site));
    if (!delivered) {
        await finish({ ok: false, reason: "page-gone" });
        return;
    }

    const cookie = await readCookie(site);
    if (cookie !== null) {
        const accepted = accept(cookie, site);
        if (accepted !== null) {
            await deliverToken(flow, accepted);
            return;
        }
    }

    try {
        const tab = await chrome.tabs.create({ url: SITE_URLS[site], active: true });
        if (tab.id !== undefined) await writeFlow({ ...flow, plaudTabId: tab.id });
    } catch {
        // Without a tab the flow waits for the timeout, like a Plaud tab the user closed.
    }
}

async function cancelFlow(): Promise<void> {
    const flow = await readFlow();
    if (flow === null) return;
    await fail(flow, "cancelled", true);
}

chrome.runtime.onMessage.addListener((message: unknown, sender) => {
    if (sender.id !== chrome.runtime.id) return;
    const popupUrl = chrome.runtime.getURL("popup.html");
    if (typeof sender.url !== "string" || !sender.url.startsWith(popupUrl)) return;
    if (isStartMessage(message)) {
        void serialized(() => startFlow(message));
        return;
    }
    if (isCancelMessage(message)) {
        void serialized(() => cancelFlow());
    }
});

chrome.cookies.onChanged.addListener((change) => {
    if (change.removed) return;
    if (change.cookie.name !== "pld_ut") return;
    void serialized(async () => {
        const flow = await readFlow();
        if (flow === null) return;
        if (!domainMatches(change.cookie.domain, flow.site)) return;
        const accepted = accept(change.cookie.value, flow.site);
        if (accepted !== null) await deliverToken(flow, accepted);
    });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status !== "complete" && changeInfo.url === undefined) return;
    void serialized(async () => {
        const flow = await readFlow();
        if (flow === null) return;
        if (tabId === flow.tabId) {
            if (changeInfo.url !== undefined) await fail(flow, "page-gone", false);
            return;
        }
        if (flow.plaudTabId !== tabId) return;
        await checkPlaudTab(flow, tabId);
    });
});

chrome.tabs.onRemoved.addListener((tabId) => {
    void serialized(async () => {
        const flow = await readFlow();
        if (flow === null) return;
        if (tabId === flow.tabId) {
            await fail(flow, "page-gone", false);
            return;
        }
        if (tabId === flow.plaudTabId) {
            const next: FlowState = { ...flow };
            delete next.plaudTabId;
            await writeFlow(next);
        }
    });
});

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== TIMEOUT_ALARM) return;
    void serialized(async () => {
        const flow = await readFlow();
        if (flow === null) return;
        await fail(flow, "timeout", true);
    });
});
