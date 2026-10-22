import AxeBuilder from "@axe-core/playwright";
import {
    type APIRequestContext,
    type Browser,
    type Page,
    type Request,
    expect,
    test,
} from "@playwright/test";
import {
    baseURL,
    clientHeaders,
    configureAccount,
    newUserContext,
    uploadRecording,
} from "../helpers/api";

// Browser tests for the signed-in shell, the Dashboard, settings and theme.
// The main account (page fixture) is only read or given harmless changes. Any
// test that saves settings runs as a fresh user in its own browser context.

type Opts = { onboarded?: boolean; configured?: boolean; colorScheme?: "light" | "dark" };

// Sign-up and sign-in are rate limited per address on the shared server, so a
// fresh account is retried with a pause when the limit answers.
async function newUserWithRetry(): Promise<APIRequestContext> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await newUserContext("ui");
        } catch (error) {
            if (attempt >= 8) throw error;
            await new Promise((resolve) => setTimeout(resolve, 15_000));
        }
    }
}

async function freshPage(browser: Browser, opts: Opts = {}) {
    const api = await newUserWithRetry();
    if (opts.configured) {
        await configureAccount(api);
    } else if (opts.onboarded !== false) {
        const done = await api.put("/api/settings/user", {
            data: { onboardingCompleted: true },
        });
        expect(done.ok()).toBeTruthy();
    }
    const ctx = await browser.newContext({
        baseURL,
        extraHTTPHeaders: clientHeaders(),
        storageState: await api.storageState(),
        colorScheme: opts.colorScheme ?? "light",
    });
    const page = await ctx.newPage();
    return {
        api,
        page,
        close: async () => {
            await ctx.close();
            await api.dispose();
        },
    };
}

function isSettingsPut(req: Request): boolean {
    return req.method() === "PUT" && req.url().endsWith("/api/settings/user");
}

function putBodyHas(req: Request, key: string, value: unknown): boolean {
    if (!isSettingsPut(req)) return false;
    try {
        return (req.postDataJSON() as Record<string, unknown>)?.[key] === value;
    } catch {
        return false;
    }
}

async function horizontalOverflow(page: Page): Promise<number> {
    return page.evaluate(
        () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
    );
}

const SECTION_TITLES: [id: string, title: string][] = [
    ["providers", "AI Providers"],
    ["transcription", "Transcription"],
    ["summary", "Summary"],
    ["naming", "Recording names"],
    ["plaud-account", "Plaud Account"],
    ["sync", "Sync"],
    ["playback", "Playback"],
    ["display", "Display"],
    ["storage", "Storage"],
    ["export", "Export"],
];

test.describe("shell: sidebar and top bar", () => {
    test("sidebar items appear in the documented order", async ({ page }) => {
        await page.goto("/dashboard");
        await expect(page.getByTestId("nav-docs")).toBeVisible();
        const ids = await page
            .getByTestId("app-sidebar")
            .locator('[data-testid^="nav-"]')
            .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")));
        expect(ids).toEqual([
            "nav-overview",
            "nav-recordings",
            "nav-collection-starred",
            "nav-collection-recent",
            "nav-collection-plaud",
            "nav-collection-uploaded",
            "nav-settings",
            "nav-docs",
        ]);
    });

    test("sidebar links point at the documented routes", async ({ page }) => {
        await page.goto("/dashboard");
        const sidebar = page.getByTestId("app-sidebar");
        await expect(sidebar.getByTestId("nav-overview")).toHaveAttribute("href", "/dashboard");
        await expect(sidebar.getByTestId("nav-recordings")).toHaveAttribute("href", "/recordings");
        await expect(sidebar.getByTestId("nav-collection-starred")).toHaveAttribute(
            "href",
            "/recordings?collection=starred",
        );
        await expect(sidebar.getByTestId("nav-collection-recent")).toHaveText(/Last 7 days/);
        await expect(sidebar.getByTestId("nav-settings")).toHaveAttribute("href", "/settings");
        await expect(sidebar.getByTestId("nav-docs")).toHaveAttribute("href", "/docs");
    });

    test("exactly the current section is marked as the current page", async ({ page }) => {
        await page.goto("/dashboard");
        await expect(page.getByTestId("nav-overview")).toHaveAttribute("aria-current", "page");
        await expect(page.getByTestId("nav-recordings")).not.toHaveAttribute("aria-current");

        await page.goto("/settings/sync");
        await expect(page.getByTestId("nav-settings")).toHaveAttribute("aria-current", "page");
        await expect(page.getByTestId("nav-overview")).not.toHaveAttribute("aria-current");

        await page.goto("/recordings?collection=recent");
        await expect(page.getByTestId("nav-collection-recent")).toHaveAttribute(
            "aria-current",
            "page",
        );
        await expect(page.getByTestId("nav-recordings")).not.toHaveAttribute("aria-current");
    });

    test("the top bar title follows the section", async ({ page }) => {
        await page.goto("/dashboard");
        await expect(page.getByTestId("topbar").getByText("Dashboard", { exact: true })).toBeVisible();
        await page.goto("/settings/sync");
        await expect(page.getByTestId("topbar").getByText("Settings", { exact: true })).toBeVisible();
    });

    test("the top bar offers upload and the account menu", async ({ page }) => {
        await page.goto("/dashboard");
        const bar = page.getByTestId("topbar");
        await expect(bar.getByTestId("upload-button")).toHaveAccessibleName("Upload audio");
        await expect(bar.getByTestId("user-menu")).toHaveAccessibleName(/^Account menu/);
    });

    test("search field and palette trigger follow the page and width", async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.goto("/dashboard");
        await expect(page.getByTestId("toolbar-search")).toBeVisible();
        await expect(page.getByTestId("command-trigger")).toHaveCount(0);

        await page.goto("/recordings");
        await expect(page.getByTestId("command-trigger")).toBeVisible();
        await expect(page.getByTestId("toolbar-search")).toHaveCount(0);

        await page.setViewportSize({ width: 375, height: 800 });
        await page.goto("/dashboard");
        await expect(page.getByTestId("toolbar-search")).toBeHidden();
    });

    test("Ctrl+B collapses and restores the docked sidebar and stores the state", async ({ page, context }) => {
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.goto("/dashboard");
        await expect(page.getByTestId("nav-overview")).toBeVisible();
        await page.keyboard.press("ControlOrMeta+b");
        await expect
            .poll(async () => (await context.cookies()).find((c) => c.name === "sidebar_state")?.value)
            .toBe("false");
        await page.keyboard.press("ControlOrMeta+b");
        await expect
            .poll(async () => (await context.cookies()).find((c) => c.name === "sidebar_state")?.value)
            .toBe("true");
    });

    test("below md the sidebar opens from the toggle button", async ({ page }) => {
        await page.setViewportSize({ width: 375, height: 800 });
        await page.goto("/dashboard");
        await expect(page.getByTestId("nav-overview")).toBeHidden();
        await page.getByRole("button", { name: "Toggle Sidebar" }).click();
        await expect(page.getByTestId("nav-overview")).toBeVisible();
    });
});

test.describe("shell: account menu", () => {
    test("the menu lists its items, theme choices and log out", async ({ page }) => {
        await page.goto("/dashboard");
        await page.getByTestId("user-menu").click();
        const menu = page.getByRole("menu");
        await expect(menu).toBeVisible();
        await expect(menu.getByRole("menuitem", { name: /^Sync now/ })).toBeVisible();
        await expect(menu.getByRole("menuitem", { name: /^Settings/ })).toBeVisible();
        await expect(menu.getByRole("menuitem", { name: /^Keyboard shortcuts/ })).toBeVisible();
        await expect(menu.getByRole("menuitemradio", { name: "Light" })).toBeVisible();
        await expect(menu.getByRole("menuitemradio", { name: "Dark" })).toBeVisible();
        await expect(menu.getByRole("menuitemradio", { name: "Auto" })).toBeVisible();
        await expect(menu.getByRole("menuitem", { name: "Log out" })).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(menu).toBeHidden();
    });

    test("the Settings item opens the settings area", async ({ page }) => {
        await page.goto("/dashboard");
        await page.getByTestId("user-menu").click();
        await page.getByRole("menuitem", { name: /^Settings/ }).click();
        await expect(page).toHaveURL(/\/settings\/[a-z-]+$/);
    });

    test("the comma key opens settings from another page", async ({ page }) => {
        await page.goto("/dashboard");
        await expect(page.getByTestId("nav-overview")).toBeVisible();
        await page.keyboard.press(",");
        await expect(page).toHaveURL(/\/settings\/[a-z-]+$/);
    });

    test("log out signs the viewer out and sends them to the landing page", async ({ browser }) => {
        const { page, close } = await freshPage(browser);
        try {
            await page.goto("/dashboard");
            await page.getByTestId("user-menu").click();
            await page.getByRole("menuitem", { name: "Log out" }).click();
            // A signed-out "/" is sent to /login.
            await page.waitForURL((url) => url.pathname === "/login");
            await page.goto("/dashboard");
            await expect(page).toHaveURL(/\/login/);
        } finally {
            await close();
        }
    });
});

test.describe("dashboard", () => {
    test("a new account sees the empty state and the set up list", async ({ browser }) => {
        const { page, close } = await freshPage(browser);
        try {
            await page.goto("/dashboard");
            await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
            await expect(page.getByRole("heading", { name: "No recordings yet" })).toBeVisible();
            await expect(page.getByTestId("overview-upload")).toBeVisible();
            await expect(page.getByTestId("overview-sync")).toBeVisible();
            await expect(page.getByRole("region", { name: "Plaud sync" })).toContainText(
                "Plaud not connected",
            );
            const setup = page.getByRole("region", { name: "Set up" });
            await expect(setup.getByRole("link", { name: "Connect Plaud" })).toHaveAttribute(
                "href",
                "/settings/plaud-account",
            );
            await expect(setup.getByRole("link", { name: "Add an AI provider" })).toHaveAttribute(
                "href",
                "/settings/providers",
            );
            await expect(page.getByRole("region", { name: "At a glance" })).toHaveCount(0);
        } finally {
            await close();
        }
    });

    test("the set up list drops the provider row once a provider exists", async ({ browser }) => {
        const { page, close } = await freshPage(browser, { configured: true });
        try {
            await page.goto("/dashboard");
            const setup = page.getByRole("region", { name: "Set up" });
            await expect(setup.getByRole("link", { name: "Connect Plaud" })).toBeVisible();
            await expect(setup.getByRole("link", { name: "Add an AI provider" })).toHaveCount(0);
        } finally {
            await close();
        }
    });

    test("with a recording the tiles, latest and recent sections link to the library", async ({ browser }) => {
        const { api, page, close } = await freshPage(browser);
        try {
            const id = await uploadRecording(api);
            await page.goto("/dashboard");
            const glance = page.getByRole("region", { name: "At a glance" });
            await expect(glance.getByRole("link", { name: /Last 7 days/ })).toHaveAttribute(
                "href",
                "/recordings?collection=recent",
            );
            await expect(glance.getByRole("link", { name: /Not transcribed/ })).toHaveAttribute(
                "href",
                "/recordings?filter=untranscribed",
            );
            await expect(glance.getByRole("link", { name: /Processing/ })).toHaveAttribute(
                "href",
                "/recordings?filter=processing",
            );

            const latest = page.getByRole("region", { name: "Latest recording" });
            await expect(latest.getByRole("link", { name: /^Open / })).toHaveAttribute(
                "href",
                `/recordings/${id}`,
            );

            const recent = page.getByRole("region", { name: "Recent recordings" });
            await expect(recent.locator(`a[href="/recordings?id=${id}"]`)).toBeVisible();
            await expect(recent.getByRole("link", { name: "Show all" })).toHaveAttribute(
                "href",
                "/recordings",
            );
        } finally {
            await close();
        }
    });

    test("a tile opens the filtered library", async ({ browser }) => {
        const { api, page, close } = await freshPage(browser);
        try {
            await uploadRecording(api);
            await page.goto("/dashboard");
            await page
                .getByRole("region", { name: "At a glance" })
                .getByRole("link", { name: /Not transcribed/ })
                .click();
            await expect(page).toHaveURL(/filter=untranscribed/);
        } finally {
            await close();
        }
    });

    test("the settings query parameter forwards to that section", async ({ page }) => {
        await page.goto("/dashboard?settings=display");
        await expect(page).toHaveURL(/\/settings\/display$/);
    });

    test("an unknown settings query shows the dashboard", async ({ page }) => {
        await page.goto("/dashboard?settings=no-such-section");
        await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    });
});

test.describe("onboarding", () => {
    test("the dialog walks four steps and only Get Started completes it", async ({ browser }) => {
        const { api, page, close } = await freshPage(browser, { onboarded: false });
        try {
            await page.goto("/dashboard");
            const dialog = page.getByTestId("onboarding-dialog");
            await expect(dialog).toBeVisible();
            const progress = dialog.getByRole("progressbar", { name: "Onboarding progress" });
            await expect(progress).toHaveAttribute("aria-valuetext", "Step 1 of 4");

            await page.keyboard.press("Escape");
            await expect(dialog).toBeVisible();

            await dialog.getByRole("button", { name: "Next" }).click();
            await expect(progress).toHaveAttribute("aria-valuetext", "Step 2 of 4");
            await dialog.getByRole("button", { name: "Skip" }).click();
            await expect(progress).toHaveAttribute("aria-valuetext", "Step 3 of 4");
            await dialog.getByRole("button", { name: "Next" }).click();
            await expect(progress).toHaveAttribute("aria-valuetext", "Step 4 of 4");

            await dialog.getByRole("button", { name: "Get Started" }).click();
            await expect(dialog).toBeHidden();
            const res = await api.get("/api/settings/user");
            expect(((await res.json()) as { onboardingCompleted?: boolean }).onboardingCompleted).toBe(true);
        } finally {
            await close();
        }
    });
});

test.describe("settings: navigation", () => {
    test.use({ viewport: { width: 1280, height: 800 } });

    test("/settings forwards to the default section, then to the last one opened", async ({ page }) => {
        await page.goto("/settings");
        await expect(page).toHaveURL(/\/settings\/providers$/);
        await page.goto("/settings/sync");
        // Wait for the section to render (it records itself as the last one opened).
        await expect(page.getByTestId("settings-section-sync")).toBeVisible();
        await page.goto("/settings");
        await expect(page).toHaveURL(/\/settings\/sync$/);
    });

    test("a notification-style hash still reaches its section", async ({ page }) => {
        await page.goto("/settings#sync");
        await expect(page).toHaveURL(/\/settings\/sync$/);
    });

    test("the section list has the web sections in order and no desktop or hidden ones", async ({ page }) => {
        await page.goto("/settings/providers");
        const nav = page.getByTestId("settings-nav");
        await expect(nav.getByRole("link").first()).toBeVisible();
        const labels = await nav
            .getByRole("link")
            .evaluateAll((els) => els.map((el) => el.getAttribute("aria-label") ?? ""));
        const web = labels.filter((l) => l !== "Developer Tools settings");
        expect(web).toEqual([
            "Providers settings",
            "Transcription settings",
            "Summary settings",
            "Recording names settings",
            "Plaud Account settings",
            "Sync settings",
            "Playback settings",
            "Display settings",
            "Storage settings",
            "Export settings",
        ]);
        await expect(nav.getByRole("link", { name: "API Keys settings" })).toHaveCount(0);
        await expect(nav.getByRole("link", { name: "Webhooks settings" })).toHaveCount(0);
        await expect(nav.getByRole("link", { name: "Desktop settings" })).toHaveCount(0);
        await expect(nav.getByRole("link", { name: "Notifications settings" })).toHaveCount(0);
    });

    test("the section search filters the list and reports no match", async ({ page }) => {
        await page.goto("/settings/providers");
        const search = page.getByTestId("settings-search");
        await search.fill("playback");
        const nav = page.getByTestId("settings-nav");
        await expect(nav.getByRole("link", { name: "Playback settings" })).toBeVisible();
        await expect(nav.getByRole("link", { name: "Sync settings" })).toHaveCount(0);
        await search.fill("zzzz-no-match");
        await expect(nav.getByText("No results")).toBeVisible();
    });

    test("each section page shows its title and container", async ({ page }) => {
        for (const [id, title] of SECTION_TITLES) {
            await page.goto(`/settings/${id}`);
            await expect(page.getByTestId(`settings-section-${id}`)).toBeVisible();
            await expect(page.getByRole("heading", { name: title, exact: true }).first()).toBeVisible();
        }
    });

    test("unknown and desktop-only sections show the not-found page", async ({ page }) => {
        for (const path of ["/settings/no-such-section", "/settings/desktop"]) {
            await page.goto(path);
            await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
            await expect(page.getByText("404", { exact: true })).toBeVisible();
        }
    });

    test("on a phone the section picker switches sections", async ({ page }) => {
        await page.setViewportSize({ width: 375, height: 800 });
        await page.goto("/settings/providers");
        await page.getByRole("combobox", { name: "Select settings section" }).click();
        await page.getByRole("option", { name: "Sync" }).click();
        await expect(page).toHaveURL(/\/settings\/sync$/);
    });
});

test.describe("settings: saving controls (fresh account)", () => {
    test.use({ viewport: { width: 1280, height: 800 } });

    test("display: items per page accepts 10 to 100 and saves once", async ({ browser }) => {
        const { page, close } = await freshPage(browser);
        try {
            await page.goto("/settings/display");
            const field = page.getByLabel("Items per page");
            const saves: Request[] = [];
            page.on("request", (req) => {
                if (isSettingsPut(req)) saves.push(req);
            });
            await field.fill("5");
            await page.waitForTimeout(1000);
            expect(saves.length).toBe(0);
            const saved = page.waitForRequest((req) => putBodyHas(req, "itemsPerPage", 25));
            await field.fill("25");
            await saved;
            await page.reload();
            await expect(page.getByLabel("Items per page")).toHaveValue("25");
        } finally {
            await close();
        }
    });

    test("display: theme choice applies at once and is saved", async ({ browser }) => {
        const { api, page, close } = await freshPage(browser);
        try {
            await page.goto("/settings/display");
            const saved = page.waitForRequest((req) => putBodyHas(req, "theme", "dark"));
            await page.getByLabel("Theme").click();
            await page.getByRole("option", { name: "Dark" }).click();
            await expect(page.locator("html")).toHaveClass(/\bdark\b/);
            await saved;
            const res = await api.get("/api/settings/user");
            expect(((await res.json()) as { theme?: string }).theme).toBe("dark");
            await page.getByLabel("Theme").click();
            await page.getByRole("option", { name: "System" }).click();
        } finally {
            await close();
        }
    });

    test("storage: retention accepts whole days from 1 to 365 only", async ({ browser }) => {
        const { page, close } = await freshPage(browser);
        try {
            await page.goto("/settings/storage");
            // The switch saves too. Wait for that save, or the listener below can count it late.
            const toggled = page.waitForResponse((res) => putBodyHas(res.request(), "autoDeleteRecordings", true));
            await page.getByRole("switch", { name: "Auto-delete old recordings" }).click();
            await toggled;
            const field = page.getByLabel("Retention period (days)");
            const saves: Request[] = [];
            page.on("request", (req) => {
                if (isSettingsPut(req)) saves.push(req);
            });
            await field.fill("400");
            await page.waitForTimeout(1000);
            expect(saves.length).toBe(0);
            const saved = page.waitForRequest((req) => putBodyHas(req, "retentionDays", 7));
            await field.fill("7");
            await saved;
            await page.reload();
            await expect(page.getByLabel("Retention period (days)")).toHaveValue("7");
        } finally {
            await close();
        }
    });

    test("sync: the interval offers six presets saved in milliseconds", async ({ browser }) => {
        const { page, close } = await freshPage(browser);
        try {
            await page.goto("/settings/sync");
            const sw = page.getByRole("switch", { name: "Enable auto-sync" });
            await expect(sw).toBeEnabled();
            if (!(await sw.isChecked())) {
                const on = page.waitForRequest((req) => putBodyHas(req, "autoSyncEnabled", true));
                await sw.click();
                await on;
            }
            await page.getByLabel("Sync interval").click();
            for (const name of ["1 minute", "2 minutes", "5 minutes", "10 minutes", "15 minutes", "30 minutes"]) {
                await expect(page.getByRole("option", { name, exact: true })).toBeVisible();
            }
            const saved = page.waitForRequest((req) => putBodyHas(req, "syncInterval", 120000));
            await page.getByRole("option", { name: "2 minutes", exact: true }).click();
            await saved;
        } finally {
            await close();
        }
    });

    test("sync: enable auto-sync saves the flag", async ({ browser }) => {
        const { page, close } = await freshPage(browser);
        try {
            await page.goto("/settings/sync");
            const sw = page.getByRole("switch", { name: "Enable auto-sync" });
            await expect(sw).toBeEnabled();
            const target = !(await sw.isChecked());
            const saved = page.waitForRequest((req) => putBodyHas(req, "autoSyncEnabled", target));
            await sw.click();
            await saved;
            await expect(sw).toBeChecked({ checked: target });
            await page.reload();
            await expect(page.getByRole("switch", { name: "Enable auto-sync" })).toBeChecked({
                checked: target,
            });
            await saved;
        } finally {
            await close();
        }
    });

    test("playback: default speed offers 0.5x to 2x and saves the pick", async ({ browser }) => {
        const { page, close } = await freshPage(browser);
        try {
            await page.goto("/settings/playback");
            await page.getByLabel("Default playback speed").click();
            await expect(page.getByRole("option", { name: "0.5x", exact: true })).toBeVisible();
            await expect(page.getByRole("option", { name: "2x", exact: true })).toBeVisible();
            const saved = page.waitForRequest((req) => putBodyHas(req, "defaultPlaybackSpeed", 1.5));
            await page.getByRole("option", { name: "1.5x", exact: true }).click();
            await saved;
        } finally {
            await close();
        }
    });

    test("transcription: auto-transcribe saves the flag", async ({ browser }) => {
        const { page, close } = await freshPage(browser);
        try {
            await page.goto("/settings/transcription");
            const saved = page.waitForRequest((req) => putBodyHas(req, "autoTranscribe", true));
            await page.getByRole("switch", { name: "Auto-transcribe new recordings" }).click();
            await saved;
        } finally {
            await close();
        }
    });

    test("recording names: the chosen mode survives a reload", async ({ browser }) => {
        const { page, close } = await freshPage(browser);
        try {
            await page.goto("/settings/naming");
            const date = page.getByTestId("recording-title-mode-date");
            const saved = page.waitForRequest(isSettingsPut);
            await date.click();
            await saved;
            await page.reload();
            await expect(page.getByTestId("recording-title-mode-date")).toBeChecked();
        } finally {
            await close();
        }
    });

    test("summary: auto-summarize saves the flag", async ({ browser }) => {
        const { page, close } = await freshPage(browser);
        try {
            await page.goto("/settings/summary");
            const saved = page.waitForRequest((req) => putBodyHas(req, "autoSummarize", true));
            await page.getByRole("switch", { name: "Auto-generate summary after transcription" }).click();
            await saved;
        } finally {
            await close();
        }
    });

    test("export: default format saves and shows after a reload", async ({ browser }) => {
        const { page, close } = await freshPage(browser);
        try {
            await page.goto("/settings/export");
            const saved = page.waitForRequest(isSettingsPut);
            await page.getByTestId("export-format").click();
            await page.getByRole("option", { name: /^SRT/ }).click();
            await saved;
            await page.reload();
            await expect(page.getByTestId("export-format")).toContainText("SRT");
        } finally {
            await close();
        }
    });

    test("export: the page offers text export and no backup action", async ({ browser }) => {
        const { page, close } = await freshPage(browser);
        try {
            await page.goto("/settings/export");
            await expect(page.getByRole("button", { name: "Export text" })).toBeVisible();
            await expect(page.getByTestId("backup-start")).toHaveCount(0);
            await expect(page.getByText("Backup frequency")).toHaveCount(0);
        } finally {
            await close();
        }
    });
});

test.describe("settings: main account, read-only", () => {
    test.use({ viewport: { width: 1280, height: 800 } });

    test("providers: the test connection result reads as connected", async ({ page }) => {
        await page.goto("/settings/providers");
        await page.getByTestId("provider-row-test").first().click();
        await expect(page.getByTestId("provider-row-test-result").first()).toHaveText(
            /^Connected · \d+ ms$/,
        );
    });

    test("a rejected save reverts the field and shows the error toast", async ({ page }) => {
        await page.route("**/api/settings/user", (route) => {
            if (route.request().method() === "PUT") {
                return route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
            }
            return route.continue();
        });
        await page.goto("/settings/display");
        const field = page.getByLabel("Items per page");
        const before = await field.inputValue();
        const next = before === "30" ? "31" : "30";
        await field.fill(next);
        await expect(
            page.getByText("Failed to save settings. Changes reverted."),
        ).toBeVisible();
        await expect(field).toHaveValue(before);
    });
});

test.describe("theme", () => {
    test.use({ viewport: { width: 1280, height: 800 } });

    test("choosing Dark from the account menu applies, persists and survives a reload", async ({ browser }) => {
        const { api, page, close } = await freshPage(browser);
        try {
            await page.goto("/dashboard");
            await page.getByTestId("user-menu").click();
            const saved = page.waitForRequest((req) => putBodyHas(req, "theme", "dark"));
            await page.getByRole("menuitemradio", { name: "Dark" }).click();
            await expect(page.locator("html")).toHaveClass(/\bdark\b/);
            await saved;
            await page.keyboard.press("Escape");
            await page.reload();
            await expect(page.locator("html")).toHaveClass(/\bdark\b/);
            const res = await api.get("/api/settings/user");
            expect(((await res.json()) as { theme?: string }).theme).toBe("dark");
        } finally {
            await close();
        }
    });

    test("choosing Light removes the dark class", async ({ browser }) => {
        const { page, close } = await freshPage(browser, { colorScheme: "dark" });
        try {
            await page.goto("/dashboard");
            await page.getByTestId("user-menu").click();
            await page.getByRole("menuitemradio", { name: "Light" }).click();
            await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
        } finally {
            await close();
        }
    });
});

test.describe("responsive and accessibility", () => {
    for (const width of [320, 375, 768, 1280, 1440]) {
        test(`dashboard and display settings fit at ${width}px`, async ({ page }) => {
            await page.setViewportSize({ width, height: 800 });
            for (const path of ["/dashboard", "/settings/display"]) {
                await page.goto(path);
                await expect(page.getByRole("main").first()).toBeVisible();
                await page.waitForLoadState("networkidle");
                expect(await horizontalOverflow(page), `${path} at ${width}px`).toBeLessThanOrEqual(0);
            }
        });
    }

    for (const scheme of ["light", "dark"] as const) {
        test.describe(`axe, ${scheme}`, () => {
            test.use({ colorScheme: scheme });

            for (const path of ["/dashboard", "/settings/display", "/settings/providers"]) {
                test(`no serious axe violations on ${path}`, async ({ page }) => {
                    await page.goto(path);
                    await expect(page.getByRole("main").first()).toBeVisible();
                    await page.waitForLoadState("networkidle");
                    const results = await new AxeBuilder({ page })
                        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
                        .analyze();
                    const blocking = results.violations
                        .filter((v) => v.impact === "serious" || v.impact === "critical")
                        .map((v) => `${v.id} (${v.impact}, ${v.nodes.length})`);
                    expect(blocking).toEqual([]);
                });
            }
        });
    }
});
