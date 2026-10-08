import { expect, test } from "@playwright/test";
import { RECORDINGS, signIn } from "./characterization/helpers";

// Covers the old-to-new URL map in docs/dev/url-map.md (T4.3).
test.describe("url map", () => {
    test.beforeEach(async ({ page }) => {
        await signIn(page);
    });

    test("/dashboard forwards to /recordings", async ({ page }) => {
        await page.goto("/dashboard");
        await expect(page).toHaveURL(/\/recordings$/);
        await expect(page.getByTestId("recording-list")).toBeVisible();
    });

    test("/dashboard?settings=<section> opens that settings section", async ({
        page,
    }) => {
        await page.goto("/dashboard?settings=webhooks");
        await expect(page).toHaveURL(/\/settings\/webhooks$/);
        await expect(
            page.getByTestId("settings-section-webhooks"),
        ).toBeVisible();
    });

    test("/settings opens Providers when nothing was visited before", async ({
        page,
    }) => {
        await page.goto("/settings");
        await expect(page).toHaveURL(/\/settings\/providers$/);
    });

    test("/settings returns to the section the viewer opened last", async ({
        page,
    }) => {
        await page.goto("/settings/sync");
        await expect(page.getByTestId("settings-section-sync")).toBeVisible();
        await page.goto("/settings");
        await expect(page).toHaveURL(/\/settings\/sync$/);
    });

    test("/settings#<section> from email links opens that section", async ({
        page,
    }) => {
        await page.goto("/settings#notifications");
        await expect(page).toHaveURL(/\/settings\/notifications$/);
    });

    test("an unknown settings section is a 404", async ({ page }) => {
        const response = await page.goto("/settings/not-a-section");
        expect(response?.status()).toBe(404);
    });

    test("/recordings?id=<id> preselects that recording", async ({ page }) => {
        await page.goto("/recordings");
        const row = page
            .getByTestId("recording-row")
            .filter({ hasText: RECORDINGS.long });
        const id = await row.getAttribute("data-id");
        expect(id).toBeTruthy();

        await page.goto(`/recordings?id=${id}`);
        await expect(page.getByTestId("player")).toContainText(RECORDINGS.long);
    });

    test("the settings navigation is made of links to each section", async ({
        page,
    }) => {
        await page.goto("/settings/providers");
        const nav = page.getByTestId("settings-nav");
        await expect(nav).toBeVisible();
        await nav.getByRole("link", { name: "Webhooks settings" }).click();
        await expect(page).toHaveURL(/\/settings\/webhooks$/);
    });
});
