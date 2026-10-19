import { type Browser, type Page, expect, test } from "@playwright/test";
import { baseURL, clientHeaders, newUserContext } from "../helpers/api";

// Browser tests for the interface language (spec/ui-app.md, "Interface language").
// Each test runs as a fresh user in its own browser context, so the choice of one test
// never reaches another.

const LANGUAGES: { tag: string; menuItem: string; dashboard: string; library: string; settings: string }[] = [
    { tag: "en", menuItem: "English", dashboard: "Dashboard", library: "Library", settings: "Settings" },
    { tag: "zh-CN", menuItem: "简体中文", dashboard: "仪表盘", library: "资料库", settings: "设置" },
    { tag: "ja", menuItem: "日本語", dashboard: "ダッシュボード", library: "ライブラリ", settings: "設定" },
    { tag: "ko", menuItem: "한국어", dashboard: "대시보드", library: "라이브러리", settings: "설정" },
];

async function signedIn(browser: Browser, locale = "en-US") {
    const api = await newUserContext("locale");
    const done = await api.put("/api/settings/user", { data: { onboardingCompleted: true } });
    expect(done.ok()).toBeTruthy();
    const ctx = await browser.newContext({
        baseURL,
        extraHTTPHeaders: clientHeaders(),
        storageState: await api.storageState(),
        colorScheme: "light",
        locale,
    });
    const page = await ctx.newPage();
    return {
        page,
        close: async () => {
            await ctx.close();
            await api.dispose();
        },
    };
}

async function chooseLanguage(page: Page, menuItem: string) {
    await page.getByTestId("user-menu").click();
    await page.getByRole("menu").getByRole("menuitemradio", { name: menuItem, exact: true }).click();
    await page.keyboard.press("Escape");
}

test.describe("interface language", () => {
    test("the account menu lists the four languages in order", async ({ browser }) => {
        const { page, close } = await signedIn(browser);
        try {
            await page.goto("/dashboard");
            await page.getByTestId("user-menu").click();
            const menu = page.getByRole("menu");
            const radios = menu.getByRole("menuitemradio");
            const names = await radios.evaluateAll((nodes) => nodes.map((n) => n.textContent?.trim()));
            const languages = names.filter((name) => ["English", "简体中文", "日本語", "한국어"].includes(name ?? ""));
            expect(languages).toEqual(["English", "简体中文", "日本語", "한국어"]);
        } finally {
            await close();
        }
    });

    test("each language translates the shell and survives a reload", async ({ browser }) => {
        const { page, close } = await signedIn(browser);
        try {
            await page.goto("/dashboard");
            for (const language of LANGUAGES) {
                await chooseLanguage(page, language.menuItem);
                await expect(page.getByRole("heading", { level: 1, name: language.dashboard, exact: true })).toBeVisible();
                await expect(page.getByTestId("nav-recordings")).toContainText(language.library);
                await expect(page.getByTestId("nav-settings")).toContainText(language.settings);
                expect(await page.evaluate(() => document.documentElement.lang)).toBe(language.tag);

                await page.reload();
                await expect(page.getByRole("heading", { level: 1, name: language.dashboard, exact: true })).toBeVisible();
                expect(await page.evaluate(() => document.documentElement.lang)).toBe(language.tag);
            }
        } finally {
            await close();
        }
    });

    test("a browser language picks the first language, and an unsupported one falls back to English", async ({ browser }) => {
        const japanese = await signedIn(browser, "ja-JP");
        try {
            await japanese.page.goto("/dashboard");
            await expect(japanese.page.getByRole("heading", { level: 1, name: "ダッシュボード", exact: true })).toBeVisible();
        } finally {
            await japanese.close();
        }
        // Traditional Chinese is served by the Simplified Chinese catalog.
        const traditional = await signedIn(browser, "zh-TW");
        try {
            await traditional.page.goto("/dashboard");
            await expect(traditional.page.getByRole("heading", { level: 1, name: "仪表盘", exact: true })).toBeVisible();
        } finally {
            await traditional.close();
        }
        const french = await signedIn(browser, "fr-FR");
        try {
            await french.page.goto("/dashboard");
            await expect(french.page.getByRole("heading", { level: 1, name: "Dashboard", exact: true })).toBeVisible();
        } finally {
            await french.close();
        }
    });

    test("dates follow the interface language", async ({ browser }) => {
        const { page, close } = await signedIn(browser);
        try {
            await page.goto("/dashboard");
            await chooseLanguage(page, "日本語");
            const heading = page.getByRole("heading", { level: 1, name: "ダッシュボード", exact: true });
            await expect(heading).toBeVisible();
            // The dashboard's date line is written by Intl for the chosen language, so the
            // weekday name appears in Japanese rather than the browser's own language.
            await expect(page.getByRole("main")).toContainText(/[日月火水木金土]/);
        } finally {
            await close();
        }
    });

    test("the language choice changes text but not the recording data", async ({ browser }) => {
        const { page, close } = await signedIn(browser);
        try {
            await page.goto("/dashboard");
            await page.evaluate(() => localStorage.setItem("locale", "zh-CN"));
            await page.goto("/recordings");
            await expect(page.getByTestId("nav-recordings")).toContainText("资料库");
            // The stored transcript language settings stay as they were.
            const settings = await page.request.get("/api/settings/user");
            expect(settings.ok()).toBeTruthy();
            const body = (await settings.json()) as { defaultTranscriptionLanguage?: string | null };
            expect(body.defaultTranscriptionLanguage ?? null).toBeNull();
        } finally {
            await close();
        }
    });

    test("the choice applies with storage blocked", async ({ browser }) => {
        const { page, close } = await signedIn(browser);
        try {
            await page.addInitScript(() => {
                const blocked = () => {
                    throw new Error("storage is disabled for this test");
                };
                Object.defineProperty(window, "localStorage", { get: blocked });
            });
            await page.goto("/dashboard");
            await expect(page.getByRole("heading", { level: 1, name: "Dashboard", exact: true })).toBeVisible();
            await chooseLanguage(page, "한국어");
            await expect(page.getByRole("heading", { level: 1, name: "대시보드", exact: true })).toBeVisible();
        } finally {
            await close();
        }
    });

    test("the signed-out pages offer the language picker", async ({ browser }) => {
        // A context of its own, without the suite's stored session, so /login really is
        // the signed-out page. The runner closes it when the test ends.
        const page = await browser.newPage({ baseURL, locale: "en-US", storageState: { cookies: [], origins: [] } });
        await page.goto("/login");
        const picker = page.getByTestId("auth-language-ja");
        await picker.click();
        await expect(picker).toHaveAttribute("aria-checked", "true");
        expect(await page.evaluate(() => document.documentElement.lang)).toBe("ja");
    });
});
