import { expect, test } from "@playwright/test";
import { signIn } from "./characterization/helpers";

test.describe("dashboard", () => {
    test.beforeEach(async ({ page }) => {
        await signIn(page);
        await page.goto("/dashboard");
    });

    test("shows the tiles and links the newest recordings", async ({
        page,
    }) => {
        await expect(
            page.getByRole("heading", { level: 1, name: "Dashboard" }),
        ).toBeVisible();
        const glance = page.getByRole("region", { name: "At a glance" });
        await expect(
            glance.getByRole("link", { name: /Last 7 days/ }),
        ).toHaveAttribute("href", "/recordings?collection=recent");
        await expect(
            glance.getByRole("link", { name: /Not transcribed/ }),
        ).toHaveAttribute("href", "/recordings?filter=untranscribed");
        await expect(
            glance.getByRole("link", { name: /Processing/ }),
        ).toHaveAttribute("href", "/recordings?filter=processing");

        const recent = page.getByRole("region", { name: "Recent recordings" });
        const links = recent.locator('a[href*="/recordings?id="]');
        await expect(links.first()).toBeVisible();
        expect(await links.count()).toBeLessThanOrEqual(8);
    });

    test("shows the Plaud sync line and the latest recording", async ({
        page,
    }) => {
        await expect(
            page.getByRole("region", { name: "Plaud sync" }),
        ).toBeVisible();
        await expect(
            page.getByRole("heading", { name: "Latest recording" }),
        ).toBeVisible();
    });

    test("a collection tile opens the filtered library", async ({ page }) => {
        await page
            .getByRole("region", { name: "At a glance" })
            .getByRole("link", { name: /Not transcribed/ })
            .click();
        await expect(page).toHaveURL(/filter=untranscribed/);
        await expect(
            page.getByTestId("recording-filter-untranscribed"),
        ).toHaveAttribute("aria-pressed", "true");
    });
});
