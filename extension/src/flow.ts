import { CONNECT_META, type FailureReason, type PageMessage } from "./protocol";
import type { Site } from "./token";

export const FLOW_KEY = "flow";
export const RESULT_KEY = "lastResult";
export const TIMEOUT_ALARM = "plaud-sign-in-timeout";

export interface FlowState {
    tabId: number;
    origin: string;
    site: Site;
    startedAt: number;
    plaudTabId?: number;
}

export type LastResult = { ok: true } | { ok: false; reason: FailureReason };

export async function readFlow(): Promise<FlowState | null> {
    const stored = await chrome.storage.session.get(FLOW_KEY);
    const flow = stored[FLOW_KEY] as FlowState | undefined;
    return flow ?? null;
}

export async function writeFlow(flow: FlowState): Promise<void> {
    await chrome.storage.session.set({ [FLOW_KEY]: flow });
}

export async function clearFlow(): Promise<void> {
    await chrome.storage.session.remove(FLOW_KEY);
}

export async function rememberResult(result: LastResult): Promise<void> {
    await chrome.storage.session.set({ [RESULT_KEY]: result });
}

/** Reads and removes the result of the last flow. */
export async function takeResult(): Promise<LastResult | null> {
    const stored = await chrome.storage.session.get(RESULT_KEY);
    const result = stored[RESULT_KEY] as LastResult | undefined;
    if (result === undefined) return null;
    await chrome.storage.session.remove(RESULT_KEY);
    return result;
}

/**
 * Runs in the page's isolated world. It checks the page origin and the connect page meta element
 * before it posts the message, so a navigated or different page never receives a token.
 */
function postToPage(message: PageMessage, origin: string, metaName: string): boolean {
    if (location.origin !== origin) return false;
    const meta = document.querySelector(`meta[name="${metaName}"]`);
    if (meta === null || meta.getAttribute("content") !== "1") return false;
    window.postMessage(message, origin);
    return true;
}

/** Delivers a message to the flow's page. `false` means the page is gone. */
export async function deliver(flow: FlowState, message: PageMessage): Promise<boolean> {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId: flow.tabId },
            func: postToPage,
            args: [message, flow.origin, CONNECT_META],
        });
        return results[0]?.result === true;
    } catch {
        return false;
    }
}

/** Brings the connect tab to the front. */
export async function focusTab(tabId: number): Promise<void> {
    try {
        const tab = await chrome.tabs.get(tabId);
        await chrome.tabs.update(tabId, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
    } catch {
        // The page may be gone. Nothing else to do.
    }
}
