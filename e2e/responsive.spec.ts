import { expect, type Page, test } from "@playwright/test";
import { RECORDINGS, signIn } from "./characterization/helpers";

// The main signed-in pages must fit a phone width without horizontal scrolling.
// The settings sections are covered by settings-sections.spec.ts.
async function horizontalOverflow(page: Page): Promise<number> {
    return page.evaluate(
        () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
    );
}

test.describe("phone layout", () => {
    test.use({ viewport: { width: 375, height: 800 } });

    test.beforeEach(async ({ page }) => {
        await signIn(page);
    });

    test("the overview fits", async ({ page }) => {
        await page.goto("/dashboard");
        await expect(
            page.getByRole("region", { name: "Totals" }),
        ).toBeVisible();
        await page.waitForLoadState("networkidle");
        expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });

    test("the library fits", async ({ page }) => {
        await page.goto("/recordings");
        await expect(page.getByTestId("recording-list")).toBeVisible();
        await page.waitForLoadState("networkidle");
        expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });

    test("a recording page fits", async ({ page }) => {
        await page.goto("/recordings");
        await expect(page.getByTestId("recording-list")).toBeVisible();
        const id = await page
            .getByTestId("recording-row")
            .filter({ hasText: RECORDINGS.long })
            .getAttribute("data-id");
        await page.goto(`/recordings/${id}`);
        await expect(page.getByTestId("player")).toBeVisible();
        await page.waitForLoadState("networkidle");
        expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });
});
