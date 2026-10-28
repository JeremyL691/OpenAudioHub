import { expect, test } from "@playwright/test";
import {
    BASE_URL,
    type Extension,
    accountToken,
    apiHeaders,
    clickClosing,
    createAccount,
    createHandoff,
    fakePlaudSite,
    findTabId,
    handoffStatus,
    jwt,
    launchExtension,
    nowSec,
    openPopup,
    setPlaudCookie,
    waitForNewPage,
} from "./helpers";

const TIMEOUT_TEXT = "Plaud sign-in timed out after 5 minutes. Click the OpenAudioHub icon to try again.";

async function connectPage(ext: Extension, code: string) {
    const page = await ext.context.newPage();
    await page.goto(`${BASE_URL}/connect/plaud?code=${encodeURIComponent(code)}`);
    await expect(page.getByTestId("connect-start")).toBeVisible();
    return page;
}

test.describe("browser extension", () => {
    test("signs in through the Plaud tab when the browser is not signed in", async () => {
        const ext = await launchExtension();
        try {
            await createAccount(ext.context);
            await fakePlaudSite(ext.context);
            const code = await createHandoff(ext.context);
            const page = await connectPage(ext, code);
            const tabId = await findTabId(ext.worker, `/connect/plaud?code=${code}`);
            const popup = await openPopup(ext, tabId);
            await expect(popup.getByTestId("popup-state")).toHaveAttribute("data-state", "confirm");
            await expect(popup.getByTestId("popup-origin")).toHaveText(BASE_URL);
            const options = popup.getByTestId("popup-site").locator("option");
            await expect(options).toHaveCount(2);
            await expect(options.nth(0)).toHaveText("Global (web.plaud.ai)");
            await expect(options.nth(1)).toHaveText("China (web.plaud.cn)");

            const token = await accountToken(`cookie.${Date.now()}@example.test`);
            const seen = new Set(ext.context.pages());
            await clickClosing(popup, "popup-connect");
            await expect(page.getByTestId("connect-waiting")).toBeVisible();
            const plaud = await waitForNewPage(ext.context, seen, "https://web.plaud.ai");
            const closed = plaud.waitForEvent("close");
            await setPlaudCookie(ext.context, token);
            await expect(page.getByTestId("connect-success")).toBeVisible();
            await closed;
            expect(await handoffStatus(ext.context, code)).toBe("connected");
        } finally {
            await ext.close();
        }
    });

    test("uses an existing Plaud session without opening a tab", async () => {
        const ext = await launchExtension();
        try {
            await createAccount(ext.context);
            await fakePlaudSite(ext.context);
            const token = await accountToken(`existing.${Date.now()}@example.test`);
            await setPlaudCookie(ext.context, token);
            const code = await createHandoff(ext.context);
            const page = await connectPage(ext, code);
            const tabId = await findTabId(ext.worker, `/connect/plaud?code=${code}`);
            const popup = await openPopup(ext, tabId);
            const seen = new Set(ext.context.pages());
            await clickClosing(popup, "popup-connect");
            await expect(page.getByTestId("connect-success")).toBeVisible();
            expect(await handoffStatus(ext.context, code)).toBe("connected");
            const opened = ext.context.pages().filter((candidate) => !seen.has(candidate));
            expect(opened).toEqual([]);
        } finally {
            await ext.close();
        }
    });

    test("keeps waiting after an expired cookie and delivers the next valid one", async () => {
        const ext = await launchExtension();
        try {
            await createAccount(ext.context);
            await fakePlaudSite(ext.context);
            await setPlaudCookie(ext.context, jwt({ sub: "expired@example.test", exp: nowSec() - 60 }));
            const code = await createHandoff(ext.context);
            const page = await connectPage(ext, code);
            const tabId = await findTabId(ext.worker, `/connect/plaud?code=${code}`);
            const popup = await openPopup(ext, tabId);
            const seen = new Set(ext.context.pages());
            await clickClosing(popup, "popup-connect");
            await expect(page.getByTestId("connect-waiting")).toBeVisible();
            await waitForNewPage(ext.context, seen, "https://web.plaud.ai");
            await page.waitForTimeout(700);
            expect(await handoffStatus(ext.context, code)).toBe("pending");

            const token = await accountToken(`valid.${Date.now()}@example.test`);
            await setPlaudCookie(ext.context, token);
            await expect(page.getByTestId("connect-success")).toBeVisible();
            expect(await handoffStatus(ext.context, code)).toBe("connected");
        } finally {
            await ext.close();
        }
    });

    test("does not deliver a workspace token", async () => {
        const ext = await launchExtension();
        try {
            await createAccount(ext.context);
            await fakePlaudSite(ext.context);
            const workspace = jwt({ sub: "workspace@example.test", exp: nowSec() + 3600, ut_ref: "ref", wid: "ws-1" });
            await setPlaudCookie(ext.context, workspace);
            const code = await createHandoff(ext.context);
            const page = await connectPage(ext, code);
            const tabId = await findTabId(ext.worker, `/connect/plaud?code=${code}`);
            const popup = await openPopup(ext, tabId);
            const seen = new Set(ext.context.pages());
            await clickClosing(popup, "popup-connect");
            await expect(page.getByTestId("connect-waiting")).toBeVisible();
            await waitForNewPage(ext.context, seen, "https://web.plaud.ai");
            await page.waitForTimeout(700);
            expect(await handoffStatus(ext.context, code)).toBe("pending");

            const token = await accountToken(`after-workspace.${Date.now()}@example.test`);
            await setPlaudCookie(ext.context, token);
            await expect(page.getByTestId("connect-success")).toBeVisible();
        } finally {
            await ext.close();
        }
    });

    test("cancel ends the flow and the page shows the cancelled text", async () => {
        const ext = await launchExtension();
        try {
            await createAccount(ext.context);
            await fakePlaudSite(ext.context);
            const code = await createHandoff(ext.context);
            const page = await connectPage(ext, code);
            const tabId = await findTabId(ext.worker, `/connect/plaud?code=${code}`);
            const popup = await openPopup(ext, tabId);
            const seen = new Set(ext.context.pages());
            await clickClosing(popup, "popup-connect");
            await expect(page.getByTestId("connect-waiting")).toBeVisible();
            await waitForNewPage(ext.context, seen, "https://web.plaud.ai");

            const waiting = await openPopup(ext, tabId);
            await expect(waiting.getByTestId("popup-state")).toHaveAttribute("data-state", "waiting");
            await clickClosing(waiting, "popup-cancel");
            await expect(page.getByTestId("connect-error")).toBeVisible();
            await expect(page.getByTestId("connect-error-text")).toHaveText(
                "Sign-in was cancelled. Click the OpenAudioHub icon to try again.",
            );
        } finally {
            await ext.close();
        }
    });

    test("closing the connect page ends the flow and the popup reports it once", async () => {
        const ext = await launchExtension();
        try {
            await createAccount(ext.context);
            await fakePlaudSite(ext.context);
            const code = await createHandoff(ext.context);
            const page = await connectPage(ext, code);
            const tabId = await findTabId(ext.worker, `/connect/plaud?code=${code}`);
            const popup = await openPopup(ext, tabId);
            await clickClosing(popup, "popup-connect");
            await expect(page.getByTestId("connect-waiting")).toBeVisible();
            await page.close();

            // The worker records the closed page when it sees the tab removed. The popup takes that
            // result once when it loads, so open it only after the worker has stored it.
            await expect
                .poll(
                    () =>
                        ext.worker.evaluate(async () => {
                            const stored = await chrome.storage.session.get("lastResult");
                            return stored.lastResult !== undefined;
                        }),
                    { timeout: 10_000 },
                )
                .toBe(true);
            const result = await ext.context.newPage();
            await result.goto(`chrome-extension://${ext.extensionId}/popup.html`);
            await expect(result.getByTestId("popup-state")).toHaveAttribute("data-state", "result");
            await expect(result.getByTestId("popup-state")).toContainText(
                "The OpenAudioHub page was closed or reloaded. Start again from that page.",
            );

            const again = await ext.context.newPage();
            await again.goto(`chrome-extension://${ext.extensionId}/popup.html`);
            await expect(again.getByTestId("popup-state")).toHaveAttribute("data-state", "help");
        } finally {
            await ext.close();
        }
    });

    test("does not treat a plain page at the connect path as a connect page", async () => {
        const ext = await launchExtension();
        try {
            await ext.context.route("http://127.0.0.1:3297/**", (route) =>
                route.fulfill({
                    status: 200,
                    contentType: "text/html",
                    body: "<!doctype html><html lang=\"en\"><head><title>Plain</title></head><body><p>Plain</p></body></html>",
                }),
            );
            const page = await ext.context.newPage();
            await page.goto("http://127.0.0.1:3297/connect/plaud?code=abc");
            const tabId = await findTabId(ext.worker, "/connect/plaud?code=abc");
            const popup = await openPopup(ext, tabId);
            await expect(popup.getByTestId("popup-state")).toHaveAttribute("data-state", "help");
            await expect(popup.getByTestId("popup-connect")).toHaveCount(0);
        } finally {
            await ext.close();
        }
    });

    test("a flow that times out ends with the timeout text", async () => {
        const ext = await launchExtension();
        try {
            await createAccount(ext.context);
            await fakePlaudSite(ext.context);
            const code = await createHandoff(ext.context);
            const page = await connectPage(ext, code);
            const tabId = await findTabId(ext.worker, `/connect/plaud?code=${code}`);
            const popup = await openPopup(ext, tabId, "&timeoutMs=1500");
            const seen = new Set(ext.context.pages());
            await clickClosing(popup, "popup-connect");
            await expect(page.getByTestId("connect-waiting")).toBeVisible();
            await waitForNewPage(ext.context, seen, "https://web.plaud.ai");
            await expect(page.getByTestId("connect-error-text")).toHaveText(TIMEOUT_TEXT, { timeout: 15_000 });

            const again = await openPopup(ext, tabId);
            await expect(again.getByTestId("popup-state")).toHaveAttribute("data-state", "confirm");
            await expect(again.getByTestId("popup-notice")).toHaveText(TIMEOUT_TEXT);
            await expect(again.getByTestId("popup-connect")).toBeVisible();
        } finally {
            await ext.close();
        }
    });

    test("offers Connect on the first click after an earlier sign-in", async () => {
        const ext = await launchExtension();
        try {
            await createAccount(ext.context);
            await fakePlaudSite(ext.context);
            await setPlaudCookie(ext.context, await accountToken(`again.${Date.now()}@example.test`));
            const first = await createHandoff(ext.context);
            const page = await connectPage(ext, first);
            const firstTab = await findTabId(ext.worker, `/connect/plaud?code=${first}`);
            await clickClosing(await openPopup(ext, firstTab), "popup-connect");
            await expect(page.getByTestId("connect-success")).toBeVisible();

            const second = await createHandoff(ext.context);
            await connectPage(ext, second);
            const secondTab = await findTabId(ext.worker, `/connect/plaud?code=${second}`);
            const popup = await openPopup(ext, secondTab);
            await expect(popup.getByTestId("popup-state")).toHaveAttribute("data-state", "confirm");
            await expect(popup.getByTestId("popup-notice")).toHaveCount(0);
            await expect(popup.getByTestId("popup-connect")).toBeVisible();
        } finally {
            await ext.close();
        }
    });

    test("sends a newer Plaud sign-in to the server without a new connect", async () => {
        const ext = await launchExtension();
        try {
            await createAccount(ext.context);
            await fakePlaudSite(ext.context);
            const email = `fresh.${Date.now()}@example.test`;
            await connectWithCookie(ext, await accountToken(email));
            const before = await connection(ext);
            expect(before.connected).toBe(true);
            await expect.poll(() => refreshOrigins(ext)).toEqual([BASE_URL]);

            // The fresh success result is shown once on a page that is not a connect page.
            const result = await ext.context.newPage();
            await result.goto(`chrome-extension://${ext.extensionId}/popup.html`);
            await expect(result.getByTestId("popup-state")).toHaveAttribute("data-state", "result");
            const help = await ext.context.newPage();
            await help.goto(`chrome-extension://${ext.extensionId}/popup.html`);
            await expect(help.getByTestId("popup-state")).toHaveAttribute("data-state", "help");
            await expect(help.getByTestId("popup-refresh")).toHaveText(`Keeps Plaud connected for ${BASE_URL}.`);

            await new Promise((resolve) => setTimeout(resolve, 1100));
            const newer = await accountToken(email);
            await setPlaudCookie(ext.context, newer);
            await expect
                .poll(async () => (await connection(ext)).tokenExpiresAt, { timeout: 15_000 })
                .not.toBe(before.tokenExpiresAt);
        } finally {
            await ext.close();
        }
    });

    test("forgets the server when the browser signs in to another Plaud account", async () => {
        const ext = await launchExtension();
        try {
            await createAccount(ext.context);
            await fakePlaudSite(ext.context);
            await connectWithCookie(ext, await accountToken(`first.${Date.now()}@example.test`));
            const before = await connection(ext);
            await expect.poll(() => refreshOrigins(ext)).toEqual([BASE_URL]);

            await new Promise((resolve) => setTimeout(resolve, 1100));
            await setPlaudCookie(ext.context, await accountToken(`other.${Date.now()}@example.test`));
            await expect.poll(() => refreshOrigins(ext), { timeout: 15_000 }).toEqual([]);
            expect((await connection(ext)).tokenExpiresAt).toBe(before.tokenExpiresAt);
        } finally {
            await ext.close();
        }
    });

    test("opens Plaud in a background tab when the token is about to expire", async () => {
        const ext = await launchExtension();
        try {
            await createAccount(ext.context);
            await fakePlaudSite(ext.context);
            const email = `renew.${Date.now()}@example.test`;
            await connectWithCookie(ext, await accountToken(email));
            const before = await connection(ext);
            await expect.poll(() => refreshOrigins(ext)).toEqual([BASE_URL]);

            // The server's token now looks a minute from expiry, and the browser has no newer one.
            await ext.worker.evaluate(async () => {
                const stored = await chrome.storage.local.get("autoRefresh");
                const map = stored.autoRefresh as Record<string, { lastExp: number | null }>;
                for (const entry of Object.values(map)) entry.lastExp = Date.now() + 60_000;
                await chrome.storage.local.set({ autoRefresh: map });
            });
            await ext.context.clearCookies({ name: "pld_ut" });

            const seen = new Set(ext.context.pages());
            await ext.worker.evaluate(() =>
                (globalThis as unknown as { oahRefreshNow: () => Promise<void> }).oahRefreshNow(),
            );
            const plaud = await waitForNewPage(ext.context, seen, "https://web.plaud.ai");
            const active = await ext.worker.evaluate(async () => {
                const tabs = await chrome.tabs.query({ url: "https://web.plaud.ai/*" });
                return tabs.map((tab) => tab.active);
            });
            expect(active).toEqual([false]);

            const closed = plaud.waitForEvent("close");
            await new Promise((resolve) => setTimeout(resolve, 1100));
            await setPlaudCookie(ext.context, await accountToken(email));
            await closed;
            await expect
                .poll(async () => (await connection(ext)).tokenExpiresAt, { timeout: 15_000 })
                .not.toBe(before.tokenExpiresAt);

            // A second check for the same token does not open another tab.
            const after = new Set(ext.context.pages());
            await ext.context.clearCookies({ name: "pld_ut" });
            await ext.worker.evaluate(async () => {
                const stored = await chrome.storage.local.get("autoRefresh");
                const map = stored.autoRefresh as Record<string, { lastExp: number | null; tabExp?: number | null }>;
                for (const entry of Object.values(map)) entry.tabExp = entry.lastExp;
                await chrome.storage.local.set({ autoRefresh: map });
            });
            await ext.worker.evaluate(() =>
                (globalThis as unknown as { oahRefreshNow: () => Promise<void> }).oahRefreshNow(),
            );
            await new Promise((resolve) => setTimeout(resolve, 1000));
            expect(ext.context.pages().filter((candidate) => !after.has(candidate))).toEqual([]);
        } finally {
            await ext.close();
        }
    });
});

/** Connects with a Plaud cookie that is already set, and waits for the page to report success. */
async function connectWithCookie(ext: Extension, token: string): Promise<void> {
    await setPlaudCookie(ext.context, token);
    const code = await createHandoff(ext.context);
    const page = await connectPage(ext, code);
    const tabId = await findTabId(ext.worker, `/connect/plaud?code=${code}`);
    await clickClosing(await openPopup(ext, tabId), "popup-connect");
    await expect(page.getByTestId("connect-success")).toBeVisible();
    await page.close();
}

async function connection(ext: Extension): Promise<{ connected: boolean; tokenExpiresAt?: string | null }> {
    const res = await ext.context.request.get("/api/plaud/connection", { headers: apiHeaders() });
    return (await res.json()) as { connected: boolean; tokenExpiresAt?: string | null };
}

async function refreshOrigins(ext: Extension): Promise<string[]> {
    return ext.worker.evaluate(async () => {
        const stored = await chrome.storage.local.get("autoRefresh");
        return Object.keys((stored.autoRefresh as Record<string, unknown> | undefined) ?? {});
    });
}
