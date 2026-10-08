import { expect, test } from "@playwright/test";
import { signIn } from "./characterization/helpers";

test.describe("@smoke", () => {
    test("signs in and lists the seeded recordings", async ({ page }) => {
        await signIn(page);
        await expect(page.getByTestId("recording-list")).toBeVisible();
        await expect(page.getByTestId("recording-row").first()).toBeVisible();
        expect(
            await page.getByTestId("recording-row").count(),
        ).toBeGreaterThanOrEqual(6);
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
