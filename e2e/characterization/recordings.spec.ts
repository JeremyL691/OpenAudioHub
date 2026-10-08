import { expect, test } from "@playwright/test";
import { openRecording, RECORDINGS, signIn } from "./helpers";

test.describe("recording library", () => {
    test.beforeEach(async ({ page }) => {
        await signIn(page);
    });

    test("renders every seeded recording", async ({ page }) => {
        const rows = page.getByTestId("recording-row");
        await expect(rows.first()).toBeVisible();
        expect(await rows.count()).toBeGreaterThanOrEqual(6);
        for (const title of Object.values(RECORDINGS)) {
            await expect(
                page.getByTestId("recording-row").filter({ hasText: title }),
            ).toHaveCount(1);
        }
    });

    test("search narrows the list and clearing it restores the list", async ({
        page,
    }) => {
        const search = page.getByTestId("recording-search");
        const rows = page.getByTestId("recording-row");
        const before = await rows.count();

        await search.fill("Long lecture");
        await expect(rows).toHaveCount(1);
        await expect(rows.first()).toContainText(RECORDINGS.long);

        await search.fill("");
        await expect(rows).toHaveCount(before);
    });

    test("sorting by name puts the alphabetically first title first", async ({
        page,
    }) => {
        await page.getByTestId("recording-sort").click();
        await page.getByRole("menuitemradio", { name: "Name" }).click();

        await expect(page.getByTestId("recording-row").first()).toContainText(
            RECORDINGS.long,
        );

        // The sort choice is saved to user settings; restore the default so later tests start from newest-first.
        await page.request.put("/api/settings/user", {
            data: { recordingListSortOrder: "newest" },
        });
    });

    test("selecting a row opens it in the detail pane", async ({ page }) => {
        await openRecording(page, RECORDINGS.untranscribed);
        await expect(page.getByTestId("player")).toBeVisible();
    });

    test("j and k move the selection through the list", async ({ page }) => {
        // Sort is persisted to user settings, so pin newest-first before checking neighbours.
        await page.request.put("/api/settings/user", {
            data: { recordingListSortOrder: "newest" },
        });
        await page.reload();
        await expect(page.getByTestId("recording-list")).toBeVisible();

        await openRecording(page, RECORDINGS.weekly);

        await page.keyboard.press("j");
        await expect(page.getByTestId("player")).not.toContainText(
            RECORDINGS.weekly,
        );

        await page.keyboard.press("k");
        await expect(page.getByTestId("player")).toContainText(
            RECORDINGS.weekly,
        );
    });
});
