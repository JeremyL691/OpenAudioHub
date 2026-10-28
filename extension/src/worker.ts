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
import {
    REFRESH_ALARM,
    REFRESH_PERIOD_MINUTES,
    RENEWAL_ALARM,
    RENEWAL_WAIT,
    isDue,
    isNewer,
    mayOpenTab,
    newRefreshKey,
    push,
    readEntries,
    readRenewal,
    removeEntry,
    saveEntry,
    tokenExpiry,
    writeRenewal,
    type RefreshEntry,
} from "./refresh";
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
    const refreshKey = newRefreshKey();
    const delivered = await deliver(flow, tokenMessage(accepted.accessToken, accepted.apiBase, refreshKey));
    if (!delivered) {
        await finish({ ok: false, reason: "page-gone" });
        return;
    }
    await saveEntry({
        origin: flow.origin,
        refreshKey,
        site: flow.site,
        lastExp: tokenExpiry(accepted.accessToken),
        addedAt: Date.now(),
    });
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

function siteOf(domain: string | undefined): Site | null {
    if (domainMatches(domain, "global")) return "global";
    if (domainMatches(domain, "cn")) return "cn";
    return null;
}

/** Sends the token to one server and records what the server now has. */
async function pushToken(entry: RefreshEntry, accepted: AcceptedToken): Promise<void> {
    const outcome = await push(entry, accepted);
    if (outcome === "retry") return;
    const current = (await readEntries()).find(
        (candidate) => candidate.origin === entry.origin && candidate.refreshKey === entry.refreshKey,
    );
    if (current === undefined) return;
    if (outcome === "drop") {
        await removeEntry(entry.origin);
        return;
    }
    const exp = tokenExpiry(accepted.accessToken);
    if (exp !== null && (current.lastExp === null || exp > current.lastExp)) {
        await saveEntry({ ...current, lastExp: exp });
    }
}

/** Offers a Plaud value to every server of its site whose token is older. True when one was newer. */
async function offerToken(site: Site, raw: string): Promise<boolean> {
    const accepted = accept(raw, site);
    if (accepted === null) return false;
    const exp = tokenExpiry(accepted.accessToken);
    let offered = false;
    for (const entry of await readEntries()) {
        if (entry.site !== site || !isNewer(exp, entry)) continue;
        offered = true;
        await pushToken(entry, accepted);
    }
    return offered;
}

/** Closes the renewal tab. With a site, only when the tab was opened for that site. */
async function endRenewal(site: Site | null): Promise<void> {
    const renewal = await readRenewal();
    if (renewal === null) return;
    if (site !== null && renewal.site !== site) return;
    await writeRenewal(null);
    await chrome.alarms.clear(RENEWAL_ALARM);
    try {
        await chrome.tabs.remove(renewal.tabId);
    } catch {
        // The user may have closed it already.
    }
}

/** Reads the renewal tab's sign-in once the Plaud page has loaded. */
async function checkRenewalTab(tabId: number): Promise<void> {
    const renewal = await readRenewal();
    if (renewal === null || renewal.tabId !== tabId) return;
    const cookie = await readCookie(renewal.site);
    if (cookie !== null && (await offerToken(renewal.site, cookie))) {
        await endRenewal(renewal.site);
        return;
    }
    const stored = await readLocalToken(tabId);
    if (stored !== null && (await offerToken(renewal.site, stored))) await endRenewal(renewal.site);
}

/**
 * Keeps every connected server on a fresh token. A newer cookie is sent at once. When the
 * server's token is about to expire and the cookie is no newer, a Plaud tab opens in the
 * background so the Plaud site renews the sign-in, and it closes again on its own.
 */
async function refreshAll(): Promise<void> {
    if ((await readFlow()) !== null) return;
    const entries = await readEntries();
    const sites = new Set(entries.map((entry) => entry.site));
    for (const site of sites) {
        const cookie = await readCookie(site);
        if (cookie !== null) await offerToken(site, cookie);
    }
    if ((await readRenewal()) !== null) return;
    const now = Date.now();
    const entry = (await readEntries()).find((candidate) => isDue(candidate, now) && mayOpenTab(candidate, now));
    if (entry === undefined) return;
    await saveEntry({ ...entry, tabAt: now, tabExp: entry.lastExp });
    try {
        const tab = await chrome.tabs.create({ url: SITE_URLS[entry.site], active: false });
        if (tab.id === undefined) return;
        await writeRenewal({ tabId: tab.id, site: entry.site });
        await chrome.alarms.create(RENEWAL_ALARM, { when: Date.now() + RENEWAL_WAIT });
    } catch {
        // Without a tab the next check tries again once the guard allows it.
    }
}

async function ensureRefreshAlarm(): Promise<void> {
    if ((await chrome.alarms.get(REFRESH_ALARM)) !== undefined) return;
    await chrome.alarms.create(REFRESH_ALARM, { delayInMinutes: 1, periodInMinutes: REFRESH_PERIOD_MINUTES });
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
        if (flow === null) {
            const site = siteOf(change.cookie.domain);
            if (site !== null && (await offerToken(site, change.cookie.value))) await endRenewal(site);
            return;
        }
        if (!domainMatches(change.cookie.domain, flow.site)) return;
        const accepted = accept(change.cookie.value, flow.site);
        if (accepted !== null) await deliverToken(flow, accepted);
    });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status !== "complete" && changeInfo.url === undefined) return;
    void serialized(async () => {
        const flow = await readFlow();
        if (flow === null) {
            await checkRenewalTab(tabId);
            return;
        }
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
        const renewal = await readRenewal();
        if (renewal !== null && renewal.tabId === tabId) {
            await writeRenewal(null);
            await chrome.alarms.clear(RENEWAL_ALARM);
        }
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
    if (alarm.name === REFRESH_ALARM) {
        void serialized(() => refreshAll());
        return;
    }
    if (alarm.name === RENEWAL_ALARM) {
        void serialized(() => endRenewal(null));
        return;
    }
    if (alarm.name !== TIMEOUT_ALARM) return;
    void serialized(async () => {
        const flow = await readFlow();
        if (flow === null) return;
        await fail(flow, "timeout", true);
    });
});

chrome.runtime.onInstalled.addListener(() => {
    void serialized(() => refreshAll());
});

chrome.runtime.onStartup.addListener(() => {
    void serialized(() => refreshAll());
});

void ensureRefreshAlarm();

if (__OAH_TEST__) {
    (globalThis as { oahRefreshNow?: () => Promise<void> }).oahRefreshNow = () => serialized(() => refreshAll());
}
