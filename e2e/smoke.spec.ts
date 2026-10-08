import { expect, type Page, test } from "@playwright/test";

async function signIn(page: Page): Promise<void> {
    await page.goto("/login");
    await page.getByLabel("Email").fill(process.env.E2E_EMAIL ?? "");
    await page.getByLabel("Password").fill(process.env.E2E_PASSWORD ?? "");
    await page.getByRole("button", { name: /sign in|log ?in/i }).click();
    await page.waitForURL("**/dashboard");
}

test.describe("@smoke", () => {
    test("signs in and lists the seeded recordings", async ({ page }) => {
        await signIn(page);
        await expect(page.getByTestId("recording-list")).toBeVisible();
        await expect(page.getByTestId("recording-row")).toHaveCount(6);
    });

    test("opens a long recording and shows its timeline", async ({ page }) => {
        await signIn(page);
        await page
            .getByTestId("recording-row")
            .filter({ hasText: "Long lecture (10 min)" })
            .getByRole("button")
            .first()
            .click();
        await expect(page.getByTestId("transcript-timeline")).toBeVisible();
        await expect(
            page.getByTestId("transcript-segment").first(),
        ).toBeVisible();
    });
});
