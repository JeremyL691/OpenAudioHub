import { expect, test } from "@playwright/test";
import {
    BASE_URL,
    type Extension,
    accountToken,
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
            await popup.getByTestId("popup-connect").click();
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
            await popup.getByTestId("popup-connect").click();
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
            await popup.getByTestId("popup-connect").click();
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
            await popup.getByTestId("popup-connect").click();
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
            await popup.getByTestId("popup-connect").click();
            await expect(page.getByTestId("connect-waiting")).toBeVisible();
            await waitForNewPage(ext.context, seen, "https://web.plaud.ai");

            const waiting = await openPopup(ext, tabId);
            await expect(waiting.getByTestId("popup-state")).toHaveAttribute("data-state", "waiting");
            // Cancel closes the popup itself, so a normal click can end with the page already gone.
            await waiting.getByTestId("popup-cancel").dispatchEvent("click");
            await expect.poll(() => waiting.isClosed()).toBe(true);
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
            await popup.getByTestId("popup-connect").click();
            await expect(page.getByTestId("connect-waiting")).toBeVisible();
            await page.close();
            await new Promise((resolve) => setTimeout(resolve, 800));

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
            await popup.getByTestId("popup-connect").click();
            await expect(page.getByTestId("connect-waiting")).toBeVisible();
            await waitForNewPage(ext.context, seen, "https://web.plaud.ai");
            await expect(page.getByTestId("connect-error-text")).toHaveText(TIMEOUT_TEXT, { timeout: 15_000 });

            const result = await ext.context.newPage();
            await result.goto(`chrome-extension://${ext.extensionId}/popup.html?tab=${tabId}`);
            await expect(result.getByTestId("popup-state")).toHaveAttribute("data-state", "result");
            await expect(result.getByTestId("popup-state")).toContainText(TIMEOUT_TEXT);
        } finally {
            await ext.close();
        }
    });
});
