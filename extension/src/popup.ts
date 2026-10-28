import { CONNECT_META, FAILURE_TEXT, connectPageFromUrl, type Site } from "./protocol";
import { readFlow, takeResult, type FlowState, type LastResult } from "./flow";
import { readEntries } from "./refresh";
import { choosePopupView } from "./view";
import type { FailureReason } from "./protocol";

const root = document.getElementById("popup") as HTMLElement;
const title = document.getElementById("popup-title") as HTMLElement;
const body = document.getElementById("popup-body") as HTMLElement;

type PopupState = "help" | "confirm" | "waiting" | "result";

function render(state: PopupState, heading: string): void {
    root.dataset.state = state;
    title.textContent = heading;
    body.replaceChildren();
}

function line(text: string, className?: string): HTMLParagraphElement {
    const element = document.createElement("p");
    if (className !== undefined) element.className = className;
    element.textContent = text;
    return element;
}

function originLine(origin: string): HTMLDivElement {
    const element = document.createElement("div");
    element.className = "origin";
    element.dataset.testid = "popup-origin";
    element.textContent = origin;
    return element;
}

function isLoopback(hostname: string): boolean {
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

async function activeTab(): Promise<chrome.tabs.Tab | null> {
    if (__OAH_TEST__) {
        const raw = new URLSearchParams(location.search).get("tab");
        const id = raw === null ? Number.NaN : Number(raw);
        if (Number.isInteger(id) && id > 0) {
            try {
                return await chrome.tabs.get(id);
            } catch {
                return null;
            }
        }
    }
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0] ?? null;
}

async function connectPageOf(tab: chrome.tabs.Tab): Promise<{ url: URL; tabId: number } | null> {
    const url = connectPageFromUrl(tab.url);
    if (url === null || tab.id === undefined) return null;
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (metaName: string) => {
                const meta = document.querySelector(`meta[name="${metaName}"]`);
                return meta?.getAttribute("content") ?? null;
            },
            args: [CONNECT_META],
        });
        if (results[0]?.result !== "1") return null;
        return { url, tabId: tab.id };
    } catch {
        return null;
    }
}

async function savedSite(): Promise<Site> {
    const stored = await chrome.storage.local.get("plaudSite");
    return stored.plaudSite === "cn" ? "cn" : "global";
}

async function start(tabId: number, origin: string, site: Site): Promise<void> {
    const message: {
        type: "start";
        tabId: number;
        origin: string;
        site: Site;
        timeoutMs?: number;
    } = { type: "start", tabId, origin, site };
    if (__OAH_TEST__) {
        const raw = new URLSearchParams(location.search).get("timeoutMs");
        const value = raw === null ? Number.NaN : Number(raw);
        if (Number.isFinite(value) && value > 0) message.timeoutMs = value;
    }
    try {
        await chrome.runtime.sendMessage(message);
    } catch {
        // The worker wakes up and takes the flow. A failed send leaves the page untouched.
    }
    window.close();
}

function renderHelp(origins: string[]): void {
    render("help", "OpenAudioHub");
    body.append(
        line(
            "To connect Plaud, open OpenAudioHub, go to Settings, then Plaud Account, and choose Sign in with Plaud. Then click this icon on the page that opens.",
        ),
    );
    for (const origin of origins) {
        const element = line(`Keeps Plaud connected for ${origin}.`);
        element.dataset.testid = "popup-refresh";
        body.append(element);
    }
}

function renderWaiting(flow: FlowState): void {
    render("waiting", "Waiting for Plaud");
    body.append(
        line("Sign in to Plaud in the Plaud tab. OpenAudioHub gets your sign-in as soon as it is ready."),
        originLine(flow.origin),
    );
    const cancel = document.createElement("button");
    cancel.dataset.testid = "popup-cancel";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => {
        void chrome.runtime.sendMessage({ type: "cancel" }).catch(() => undefined);
        window.close();
    });
    body.append(cancel);
}

function renderResult(result: LastResult): void {
    render("result", "OpenAudioHub");
    body.append(line(result.ok ? "Sent to OpenAudioHub. Check the OpenAudioHub page for the result." : FAILURE_TEXT[result.reason]));
}

function renderConfirm(url: URL, tabId: number, site: Site, failure: FailureReason | null): void {
    render("confirm", "Connect Plaud");
    if (failure !== null) {
        const notice = line(FAILURE_TEXT[failure], "warning");
        notice.dataset.testid = "popup-notice";
        body.append(notice);
    }
    body.append(line("Send your Plaud sign-in to this OpenAudioHub server?"), originLine(url.origin));

    const label = document.createElement("label");
    label.htmlFor = "popup-site";
    label.textContent = "Plaud site";
    const select = document.createElement("select");
    select.id = "popup-site";
    select.dataset.testid = "popup-site";
    const choices: [Site, string][] = [
        ["global", "Global (web.plaud.ai)"],
        ["cn", "China (web.plaud.cn)"],
    ];
    for (const [value, text] of choices) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = text;
        option.selected = value === site;
        select.append(option);
    }
    select.addEventListener("change", () => {
        const chosen: Site = select.value === "cn" ? "cn" : "global";
        void chrome.storage.local.set({ plaudSite: chosen });
    });
    body.append(label, select);

    const connect = document.createElement("button");
    connect.dataset.testid = "popup-connect";
    connect.textContent = "Connect";
    connect.addEventListener("click", () => {
        const chosen: Site = select.value === "cn" ? "cn" : "global";
        void start(tabId, url.origin, chosen);
    });
    body.append(connect, line("If you are not signed in to Plaud in this browser, Plaud opens in a new tab."));
    if (url.protocol === "http:" && !isLoopback(url.hostname)) {
        body.append(line("This server does not use HTTPS. Your Plaud sign-in will travel unencrypted.", "warning"));
    }
}

async function main(): Promise<void> {
    const flow = await readFlow();
    if (flow !== null) {
        renderWaiting(flow);
        return;
    }
    const result = await takeResult();
    const tab = await activeTab();
    const page = tab === null ? null : await connectPageOf(tab);
    const view = choosePopupView({ hasFlow: false, result, isConnectPage: page !== null, now: Date.now() });
    if (view.state === "confirm" && page !== null) {
        renderConfirm(page.url, page.tabId, await savedSite(), view.failure);
        return;
    }
    if (view.state === "result") {
        renderResult(view.result);
        return;
    }
    await showHelp();
}

async function showHelp(): Promise<void> {
    let origins: string[] = [];
    try {
        origins = (await readEntries()).map((entry) => entry.origin);
    } catch {
        // The help text does not depend on the list.
    }
    renderHelp(origins);
}

void main().catch(() => showHelp());
