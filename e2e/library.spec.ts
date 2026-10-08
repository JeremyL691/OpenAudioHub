import { expect, test } from "@playwright/test";
import { RECORDINGS, signIn } from "./characterization/helpers";

test.describe("library", () => {
    test.beforeEach(async ({ page }) => {
        await signIn(page);
    });

    test("status chips narrow the list to matching recordings", async ({
        page,
    }) => {
        const list = page.getByTestId("recording-list");
        const untranscribed = page.getByTestId(
            "recording-filter-untranscribed",
        );

        await untranscribed.click();
        await expect(untranscribed).toHaveAttribute("aria-pressed", "true");
        await expect(list).toContainText(RECORDINGS.untranscribed);
        await expect(list).not.toContainText(RECORDINGS.weekly);

        await page.getByTestId("recording-filter-all").click();
        await expect(list).toContainText(RECORDINGS.weekly);
    });

    test("each row shows its source and transcript state", async ({ page }) => {
        const row = page
            .getByTestId("recording-row")
            .filter({ hasText: RECORDINGS.weekly });

        await expect(row).toContainText("Summary ready");
        await expect(row).toContainText(/Plaud|Upload/);
    });

    test("server pipeline jobs show their phase and count as processing", async ({
        page,
    }) => {
        // The seeded "Processing now" recording has a running pipeline job in
        // the transcribing phase, and "Paused for disk" a paused one.
        const list = page.getByTestId("recording-list");
        const processingRow = page
            .getByTestId("recording-row")
            .filter({ hasText: RECORDINGS.processing });
        await expect(processingRow).toContainText("Transcribing speech");
        await expect(processingRow).not.toContainText("Not transcribed");

        await page.getByTestId("recording-filter-processing").click();
        await expect(list).toContainText(RECORDINGS.processing);
        await expect(list).not.toContainText(RECORDINGS.weekly);
    });

    test("the row menu offers Transcribe", async ({ page }) => {
        const row = page
            .getByTestId("recording-row")
            .filter({ hasText: RECORDINGS.untranscribed });

        await row.getByRole("button", { name: "Row actions" }).click();
        await expect(
            page.getByRole("menuitem", { name: "Transcribe", exact: true }),
        ).toBeVisible();
        await page.keyboard.press("Escape");
    });

    test("the preview links to the full view of the selected recording", async ({
        page,
    }) => {
        await page
            .getByTestId("recording-row")
            .filter({ hasText: RECORDINGS.weekly })
            .getByRole("button")
            .first()
            .click();

        await expect(page.getByTestId("open-full-view")).toHaveAttribute(
            "href",
            /\/recordings\/[^/]+$/,
        );
    });

    test("renames a recording from the row menu, then restores its name", async ({
        page,
    }) => {
        const renamed = `${RECORDINGS.untranscribed} (renamed)`;

        const rename = async (from: string, to: string) => {
            await page
                .getByTestId("recording-row")
                .filter({ hasText: from })
                .getByRole("button", { name: "Row actions" })
                .click();
            await page.getByRole("menuitem", { name: "Rename" }).click();
            await page
                .getByRole("textbox", { name: "Name", exact: true })
                .fill(to);
            await page
                .getByRole("button", { name: "Save", exact: true })
                .click();
            await expect(
                page.getByTestId("recording-row").filter({ hasText: to }),
            ).toHaveCount(1);
        };

        await rename(RECORDINGS.untranscribed, renamed);
        await rename(renamed, RECORDINGS.untranscribed);
    });
});
