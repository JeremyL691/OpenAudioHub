import { expect, test } from "@playwright/test";
import { signIn } from "./characterization/helpers";

test.describe("not found", () => {
    test("signed-in visitors get a way back to their recordings", async ({
        page,
    }) => {
        await signIn(page);
        const response = await page.goto("/no-such-page");

        expect(response?.status()).toBe(404);
        await expect(
            page.getByRole("heading", { level: 1, name: "Page not found" }),
        ).toBeVisible();
        await expect(
            page.getByRole("link", { name: "Go to recordings" }),
        ).toHaveAttribute("href", "/recordings");
    });

    test.describe("signed out", () => {
        test.use({ storageState: { cookies: [], origins: [] } });

        test("visitors get a way back to the home page", async ({ page }) => {
            const response = await page.goto("/no-such-page");

            expect(response?.status()).toBe(404);
            await expect(
                page.getByRole("link", { name: "Back to home" }),
            ).toHaveAttribute("href", "/");
        });
    });
});
