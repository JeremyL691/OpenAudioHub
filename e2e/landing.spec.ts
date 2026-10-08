import { expect, test } from "@playwright/test";

test.describe("landing page", () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test("shows the slogan, the feature list, and sign-in", async ({
        page,
    }) => {
        await page.goto("/");

        await expect(page.getByRole("heading", { level: 1 })).toHaveText(
            "Long recordings, intelligently transcribed.",
        );
        await expect(page.getByRole("heading", { level: 3 })).toHaveCount(6);
        await expect(
            page.getByRole("link", { name: "Sign in" }).first(),
        ).toHaveAttribute("href", "/login");
    });
});

test("signed-in visitors skip the landing page", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/dashboard$/);
});
