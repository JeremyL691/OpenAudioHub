import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { signIn } from "./characterization/helpers";

// Every settings section must fit a phone or a desktop viewport without
// horizontal scrolling. SHOT_SET (for example "after") also writes a full-page
// capture of each section, for review, to .dev-artifacts/screenshots/<SHOT_SET>/.
const SHOT_SET = process.env.SHOT_SET;

// The developer tools section is only in development builds, so it is not here.
const SECTIONS = [
    "providers",
    "transcription",
    "summary",
    "plaud-account",
    "sync",
    "playback",
    "display",
    "notifications",
    "storage",
    "export",
    "api-keys",
    "webhooks",
] as const;

const WIDTHS = [375, 1280] as const;

async function horizontalOverflow(page: Page): Promise<number> {
    return page.evaluate(
        () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
    );
}

test.describe("settings sections", () => {
    test.beforeEach(async ({ page }) => {
        await signIn(page);
    });

    for (const width of WIDTHS) {
        for (const section of SECTIONS) {
            test(`${section} fits at ${width}px`, async ({ page }) => {
                await page.setViewportSize({ width, height: 900 });
                await page.goto(`/settings/${section}`);
                await expect(
                    page.getByRole("main").getByRole("heading").first(),
                ).toBeVisible();
                await page.waitForLoadState("networkidle");

                expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

                if (SHOT_SET) {
                    const outDir = path.resolve(
                        __dirname,
                        "../.dev-artifacts/screenshots",
                        SHOT_SET,
                    );
                    mkdirSync(outDir, { recursive: true });
                    await page.screenshot({
                        path: path.join(
                            outDir,
                            `settings-${section}-${width}-light.png`,
                        ),
                        fullPage: true,
                    });
                }
            });
        }
    }

    test("the display theme applies at once and is restored afterwards", async ({
        page,
    }) => {
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.goto("/settings/display");

        await page.locator("#theme").click();
        await page.getByRole("option", { name: "Dark" }).click();
        await expect(page.locator("html")).toHaveClass(/\bdark\b/);

        await page.locator("#theme").click();
        await page.getByRole("option", { name: "System" }).click();
        await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
    });
});
