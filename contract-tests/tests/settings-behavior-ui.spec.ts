import { type APIRequestContext, type Browser, expect, type Page, type Route, test } from "@playwright/test";
import { baseURL, clientHeaders, newUserContext, uploadRecording } from "../helpers/api";

test.use({ viewport: { width: 1280, height: 800 } });

async function account(browser: Browser, patch: Record<string, unknown> = {}) {
    const api = await newUserContext("settings-behavior");
    expect((await api.put("/api/settings/user", { data: {
        onboardingCompleted: true, autoSyncEnabled: false, syncOnMount: false,
        syncOnVisibilityChange: false, ...patch,
    } })).ok()).toBeTruthy();
    const context = await browser.newContext({ baseURL, locale: "en-US", extraHTTPHeaders: clientHeaders(), storageState: await api.storageState() });
    await context.addInitScript(() => {
        const original = window.fetch.bind(window);
        (window as unknown as { syncRequests: number }).syncRequests = 0;
        window.fetch = (input, init) => {
            if (String(input).endsWith("/api/plaud/sync") && init?.method === "POST") {
                (window as unknown as { syncRequests: number }).syncRequests++;
            }
            return original(input, init);
        };
    });
    const page = await context.newPage();
    return { api, page, close: async () => { await context.close(); await api.dispose(); } };
}

async function recording(api: APIRequestContext, title: string): Promise<string> {
    const id = await uploadRecording(api);
    expect((await api.patch(`/api/recordings/${id}`, { data: { filename: title } })).ok()).toBeTruthy();
    return id;
}

async function visibility(page: Page, state: "hidden" | "visible"): Promise<number> {
    return page.evaluate((value) => {
        Object.defineProperty(document, "visibilityState", { configurable: true, value });
        document.dispatchEvent(new Event("visibilitychange"));
        return (window as unknown as { syncRequests: number }).syncRequests;
    }, state);
}

const syncResult = { success: true, newRecordings: 0, updatedRecordings: 0, errors: [], needsReconnect: false };

test("auto-play follows filtered name order, plays next, and stops at the last or excluded recording", async ({ browser }) => {
    const user = await account(browser, { autoPlayNext: true, recordingListSortOrder: "name" });
    const { page, api } = user;
    try {
        const bravo = await recording(api, "Queue Bravo");
        const alpha = await recording(api, "Queue Alpha");
        await recording(api, "Excluded");
        await page.goto("/recordings?q=Queue");
        const rows = page.getByTestId("recording-row");
        await expect(rows).toHaveCount(2);
        await expect(rows.first()).toContainText("Queue Alpha");
        await rows.first().locator("button").first().click();
        await expect(page.getByTestId("player-play")).toBeEnabled();
        await page.getByTestId("player-play").click();
        await expect.poll(() => page.locator("audio").evaluate((el: HTMLAudioElement) => el.paused)).toBe(false);
        await page.locator("audio").evaluate((el: HTMLAudioElement) => { el.pause(); el.dispatchEvent(new Event("ended")); });
        await expect(page.locator("audio")).toHaveAttribute("src", `/api/recordings/${bravo}/audio`);
        await expect(rows.filter({ hasText: "Queue Bravo" }).locator("button").first()).toHaveAttribute("aria-current", "true");
        await expect.poll(() => page.locator("audio").evaluate((el: HTMLAudioElement) => el.paused)).toBe(false);
        const last = await page.locator("audio").evaluate((el: HTMLAudioElement) => {
            el.pause(); el.dispatchEvent(new Event("ended")); return el.getAttribute("src");
        });
        expect(last).toBe(`/api/recordings/${bravo}/audio`);
        await rows.filter({ hasText: "Queue Alpha" }).locator("button").first().click();
        await page.getByTestId("player-play").click();
        await page.locator("audio").evaluate((el: HTMLAudioElement) => el.pause());
        await page.getByTestId("recording-search").fill("Queue Bravo");
        await expect(rows).toHaveCount(1);
        const excluded = await page.locator("audio").evaluate((el: HTMLAudioElement) => { el.dispatchEvent(new Event("ended")); return el.getAttribute("src"); });
        expect(excluded).toBe(`/api/recordings/${alpha}/audio`);
    } finally { await user.close(); }
});

test("disabled auto-play and an empty library never advance", async ({ browser }) => {
    const user = await account(browser, { autoPlayNext: false, recordingListSortOrder: "name" });
    const { api, page } = user;
    try {
        await page.goto("/recordings");
        await expect(page.getByTestId("recording-row")).toHaveCount(0);
        await page.locator("audio").evaluate((el: HTMLAudioElement) => el.dispatchEvent(new Event("ended")));
        await expect(page.locator("audio")).not.toHaveAttribute("src");
        const id = await recording(api, "First");
        await recording(api, "Second");
        await page.reload();
        const row = page.getByTestId("recording-row").filter({ hasText: "First" });
        await row.locator("button").first().click();
        await expect(page.getByTestId("player-play")).toBeEnabled();
        await page.getByTestId("player-play").click();
        const src = await page.locator("audio").evaluate((el: HTMLAudioElement) => { el.pause(); el.dispatchEvent(new Event("ended")); return el.getAttribute("src"); });
        expect(src).toBe(`/api/recordings/${id}/audio`);
    } finally { await user.close(); }
});

for (const format of ["relative", "absolute", "iso"] as const) {
    test(`${format} dates agree across library, detail and player`, async ({ browser }) => {
        const user = await account(browser, { dateTimeFormat: format });
        const { page, api } = user;
        try {
            const id = await recording(api, "Date preference");
            const start = new Date(Date.now() - 5 * 60_000).toISOString();
            await page.route("**/api/recordings", async (route) => {
                const response = await route.fetch();
                const body = await response.json();
                body.recordings = body.recordings.map((r: Record<string, unknown>) => ({ ...r, startTime: start }));
                await route.fulfill({ response, json: body });
            });
            await page.route(`**/api/recordings/${id}`, async (route) => {
                const response = await route.fetch();
                const body = await response.json();
                body.recording.startTime = start;
                await route.fulfill({ response, json: body });
            });
            await page.goto("/recordings");
            const expected = format === "iso" ? start : format === "relative" ? "5 minutes ago" : await page.evaluate((value) => new Date(value).toLocaleString("en-US"), start);
            const row = page.getByTestId("recording-row");
            await expect(row).toContainText(expected);
            await expect(row.locator("button").first()).toHaveAccessibleName(new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
            await row.locator("button").first().click();
            await expect(page.getByTestId("player").locator("time")).toContainText(expected);
            await page.getByRole("tab", { name: "Details", exact: true }).click();
            await expect(page.getByTestId("details-card")).toContainText(expected);
        } finally { await user.close(); }
    });
}

test("visibility sync observes saved toggles immediately, respects lock/throttle, and ignores a failed save", async ({ browser }) => {
    const user = await account(browser);
    const { page } = user;
    let held: Route | undefined;
    let hold = true;
    let failSave = false;
    try {
        await page.clock.install();
        await page.route("**/api/plaud/connection", (route) => route.fulfill({ json: { connected: true } }));
        await page.route("**/api/plaud/sync", async (route) => {
            if (hold) { held = route; return; }
            await route.fulfill({ json: syncResult });
        });
        await page.route("**/api/settings/user", async (route) => {
            if (failSave && route.request().method() === "PUT") {
                failSave = false;
                await route.fulfill({ status: 500, json: { error: "Save rejected" } });
            } else await route.continue();
        });
        await page.goto("/settings/sync");
        const toggle = page.getByRole("switch", { name: "Sync on tab visibility", exact: true });
        await expect(toggle).not.toBeChecked();
        expect(await visibility(page, "visible")).toBe(0);
        await toggle.click();
        await expect(toggle).toBeChecked();
        await expect(toggle).toBeEnabled();
        expect(await visibility(page, "hidden")).toBe(0);
        expect(await visibility(page, "visible")).toBe(1);
        await expect.poll(() => Boolean(held)).toBe(true);
        await page.clock.fastForward(60_001);
        expect(await visibility(page, "visible")).toBe(1);
        await toggle.click();
        await expect(toggle).not.toBeChecked();
        await expect(toggle).toBeEnabled();
        const finished = page.waitForResponse("**/api/plaud/sync");
        await held!.fulfill({ json: syncResult });
        await (await finished).finished();
        hold = false;
        expect(await visibility(page, "visible")).toBe(1);
        await toggle.click();
        await expect(toggle).toBeChecked();
        await expect(toggle).toBeEnabled();
        const synced = page.waitForResponse("**/api/plaud/sync");
        expect(await visibility(page, "visible")).toBe(2);
        await (await synced).finished();
        expect(await visibility(page, "visible")).toBe(2);
        failSave = true;
        await toggle.click();
        await expect(page.getByText("Failed to save settings. Changes reverted.", { exact: true })).toBeVisible();
        await expect(toggle).toBeChecked();
        await expect(toggle).toBeEnabled();
        await page.clock.fastForward(60_001);
        expect(await visibility(page, "visible")).toBe(3);
        await expect(page).toHaveURL(/\/settings\/sync$/);
    } finally { await user.close(); }
});

for (const gate of ["local-only", "disconnected"] as const) {
    test(`visibility sync stays off when ${gate}`, async ({ browser }) => {
        const user = await account(browser, { syncOnVisibilityChange: true, plaudEnabled: gate !== "local-only" });
        try {
            await user.page.route("**/api/plaud/connection", (route) => route.fulfill({ json: { connected: gate !== "disconnected" } }));
            await user.page.goto("/dashboard");
            await expect(user.page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
            expect(await visibility(user.page, "visible")).toBe(0);
        } finally { await user.close(); }
    });
}

test("an in-flight shell settings response cannot revert a newer saved visibility preference", async ({ browser }) => {
    const user = await account(browser);
    const { page } = user;
    let stale: { route: Route; body: string } | undefined;
    try {
        await page.route("**/api/plaud/connection", (route) => route.fulfill({ json: { connected: true } }));
        await page.route("**/api/plaud/sync", (route) => route.fulfill({ json: syncResult }));
        await page.goto("/settings/playback");
        await expect(page.getByRole("switch", { name: "Auto-play next recording", exact: true })).toBeEnabled();
        await page.route("**/api/settings/user", async (route) => {
            if (route.request().method() === "GET") {
                const response = await route.fetch();
                stale = { route, body: await response.text() };
            } else await route.continue();
        });
        await page.getByTestId("settings-nav").getByRole("link", { name: "Sync settings", exact: true }).click();
        const toggle = page.getByRole("switch", { name: "Sync on tab visibility", exact: true });
        await expect(toggle).toBeEnabled();
        await expect.poll(() => Boolean(stale)).toBe(true);
        await toggle.click();
        await expect(toggle).toBeChecked();
        await expect(toggle).toBeEnabled();
        const response = page.waitForResponse("**/api/settings/user");
        await stale!.route.fulfill({ contentType: "application/json", body: stale!.body });
        await (await response).finished();
        expect(await visibility(page, "visible")).toBe(1);
    } finally { await user.close(); }
});
