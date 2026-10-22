import { chromium, expect, request, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const BASE_URL = "http://127.0.0.1:3290";
export const FAKE_PLAUD_URL = "http://127.0.0.1:3298";
const EXTENSION_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../dist-test");

export interface Extension {
    context: BrowserContext;
    worker: Worker;
    extensionId: string;
    close: () => Promise<void>;
}

/** Launches Chromium with the test build loaded, on its own profile. */
export async function launchExtension(): Promise<Extension> {
    const userDataDir = await mkdtemp(join(tmpdir(), "oah-extension-"));
    const context = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        channel: "chromium",
        baseURL: BASE_URL,
        viewport: { width: 1100, height: 800 },
        args: [
            "--no-first-run",
            "--no-default-browser-check",
            `--disable-extensions-except=${EXTENSION_PATH}`,
            `--load-extension=${EXTENSION_PATH}`,
        ],
    });
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 20_000 });
    const extensionId = new URL(worker.url()).host;
    return {
        context,
        worker,
        extensionId,
        close: async () => {
            await context.close();
            await rm(userDataDir, { recursive: true, force: true });
        },
    };
}

export interface Account {
    email: string;
    password: string;
    headers: Record<string, string>;
}

function randomIp(): string {
    return `10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;
}

/** The headers the API requires from a browser-style client. */
export function apiHeaders(): Record<string, string> {
    return { origin: BASE_URL, "x-forwarded-for": randomIp() };
}

async function retryingPost(
    context: BrowserContext,
    path: string,
    data: unknown,
    headers: Record<string, string>,
) {
    let last = await context.request.post(path, { data, headers });
    for (let attempt = 0; attempt < 3 && last.status() === 429; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        headers = apiHeaders();
        last = await context.request.post(path, { data, headers });
    }
    return last;
}

/** Creates and signs in an account, using the context's cookie jar. */
export async function createAccount(context: BrowserContext): Promise<Account> {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const email = `extension.${stamp}@example.test`;
    const password = "extension-password-1";
    const headers = apiHeaders();
    const signUp = await retryingPost(context, "/api/auth/sign-up/email", { name: "Extension Test", email, password }, headers);
    if (!signUp.ok()) throw new Error(`sign-up failed: ${signUp.status()} ${await signUp.text()}`);
    const signIn = await retryingPost(context, "/api/auth/sign-in/email", { email, password }, headers);
    if (!signIn.ok()) throw new Error(`sign-in failed: ${signIn.status()} ${await signIn.text()}`);
    await context.request.put("/api/settings/user", { data: { onboardingCompleted: true }, headers });
    return { email, password, headers };
}

export async function createHandoff(context: BrowserContext): Promise<string> {
    const res = await context.request.post("/api/plaud/auth/handoff", { headers: apiHeaders() });
    if (!res.ok()) throw new Error(`handoff failed: ${res.status()} ${await res.text()}`);
    return ((await res.json()) as { code: string }).code;
}

export async function handoffStatus(context: BrowserContext, code: string): Promise<string> {
    const res = await context.request.get(`/api/plaud/auth/handoff?code=${encodeURIComponent(code)}`, {
        headers: apiHeaders(),
    });
    return ((await res.json()) as { status: string }).status;
}

export async function findTabId(worker: Worker, urlPart: string): Promise<number> {
    const id = await worker.evaluate(async (part: string) => {
        const tabs = await chrome.tabs.query({});
        return tabs.find((tab) => (tab.url ?? "").includes(part))?.id ?? null;
    }, urlPart);
    if (id === null) throw new Error(`no tab matching ${urlPart}`);
    return id;
}

export async function openPopup(ext: Extension, tabId: number, query = ""): Promise<Page> {
    const page = await ext.context.newPage();
    await page.goto(`chrome-extension://${ext.extensionId}/popup.html?tab=${tabId}${query}`);
    await page.locator('[data-testid="popup-state"]').waitFor();
    return page;
}

/** Clicks a popup button that closes the popup itself, then waits until the popup has closed. */
export async function clickClosing(popup: Page, testId: string): Promise<void> {
    await popup.getByTestId(testId).dispatchEvent("click");
    await expect.poll(() => popup.isClosed(), { timeout: 10_000 }).toBe(true);
}

/** Fulfills every Plaud web request with a plain page, so no test touches the network. */
export async function fakePlaudSite(context: BrowserContext): Promise<void> {
    await context.route("https://web.plaud.ai/**", (route) =>
        route.fulfill({
            status: 200,
            contentType: "text/html",
            body: "<!doctype html><html lang=\"en\"><head><title>Plaud</title></head><body><p>Plaud</p></body></html>",
        }),
    );
}

export async function setPlaudCookie(context: BrowserContext, value: string): Promise<void> {
    await context.addCookies([
        {
            name: "pld_ut",
            value,
            domain: ".plaud.ai",
            path: "/",
            secure: true,
            httpOnly: true,
            sameSite: "Lax",
        },
    ]);
}

/** The first page that appeared after `seen` and whose URL starts with `prefix`. */
export async function waitForNewPage(
    context: BrowserContext,
    seen: Set<Page>,
    prefix: string,
): Promise<Page> {
    const deadline = Date.now() + 20_000;
    while (true) {
        if (Date.now() >= deadline) break;
        for (const page of context.pages()) {
            if (!seen.has(page) && page.url().startsWith(prefix)) return page;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`no new page matching ${prefix}`);
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

export function jwt(claims: Record<string, unknown>): string {
    return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}.ZmFrZQ`;
}

export const nowSec = () => Math.floor(Date.now() / 1000);

/** An account token issued by the fake Plaud API. */
export async function accountToken(email: string): Promise<string> {
    const context = await request.newContext({ baseURL: FAKE_PLAUD_URL });
    try {
        const sent = await context.post("/auth/otp-send-code", { data: { username: email } });
        const { token } = (await sent.json()) as { token: string };
        const login = await context.post("/auth/otp-login", { data: { code: "123456", token } });
        return ((await login.json()) as { access_token: string }).access_token;
    } finally {
        await context.dispose();
    }
}
