import { expect, test } from "@playwright/test";
import { signIn } from "./characterization/helpers";

test.describe("overview", () => {
    test.beforeEach(async ({ page }) => {
        await signIn(page);
        await page.goto("/dashboard");
    });

    test("shows the totals and links the newest recordings", async ({
        page,
    }) => {
        const totals = page.getByRole("region", { name: "Totals" });
        await expect(totals).toContainText("Recordings");
        await expect(totals).toContainText("Total time");
        await expect(totals).toContainText("Transcribed");
        await expect(totals).toContainText("Summarized");

        const recent = page.getByRole("region", { name: "Recent recordings" });
        const links = recent.locator('a[href*="/recordings?id="]');
        await expect(links.first()).toBeVisible();
        expect(await links.count()).toBeLessThanOrEqual(8);
    });

    test("shows the Plaud sync card and the processing card", async ({
        page,
    }) => {
        await expect(
            page.getByRole("region", { name: "Plaud sync" }),
        ).toBeVisible();
        await expect(
            page.getByRole("region", { name: "Processing" }),
        ).toBeVisible();
    });
});
