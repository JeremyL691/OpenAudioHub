import { readFileSync } from "node:fs";
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

    test("selected recordings download as one ZIP of MP3s", async ({
        page,
    }) => {
        await page.getByTestId("recording-select-mode").click();
        for (const title of [RECORDINGS.weekly, RECORDINGS.untranscribed]) {
            const row = page
                .getByTestId("recording-row")
                .filter({ hasText: title });
            await row.getByRole("button").first().click();
            await expect(row.getByRole("button").first()).toHaveAttribute(
                "aria-pressed",
                "true",
            );
        }
        await expect(page.getByText("2 selected")).toBeVisible();

        const download = page.waitForEvent("download");
        await page.getByTestId("recording-bulk-download").click();
        const zip = await download;
        expect(zip.suggestedFilename()).toMatch(
            /^OpenAudioHub-\d{4}-\d{2}-\d{2}\.zip$/,
        );
        expect(await zip.failure()).toBeNull();

        await page.getByTestId("recording-select-cancel").click();
        await expect(page.getByTestId("recording-select-mode")).toBeVisible();
    });

    test("a single recording downloads as MP3", async ({ page }) => {
        const row = page
            .getByTestId("recording-row")
            .filter({ hasText: RECORDINGS.weekly });
        await row.hover();
        await row.getByRole("button", { name: "Row actions" }).click();
        const download = page.waitForEvent("download");
        await page.getByRole("menuitem", { name: "Download audio" }).click();
        const file = await download;
        expect(file.suggestedFilename()).toBe(`${RECORDINGS.weekly}.mp3`);
        expect(await file.failure()).toBeNull();
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

    test("selected recordings merge into one in a chosen order", async ({
        page,
    }) => {
        const audio = readFileSync("src/tests/fixtures/sample.mp3");
        const titles: string[] = [];
        for (const name of ["Merge part A", "Merge part B"]) {
            const res = await page.request.post("/api/recordings/upload", {
                multipart: {
                    file: {
                        name: `${name}.mp3`,
                        mimeType: "audio/mpeg",
                        buffer: audio,
                    },
                },
            });
            expect(res.ok()).toBe(true);
            titles.push((await res.json()).filename);
        }
        await page.reload();

        await page.getByTestId("recording-select-mode").click();
        for (const title of titles) {
            await page
                .getByTestId("recording-row")
                .filter({ hasText: title })
                .getByRole("button")
                .first()
                .click();
        }
        await page.getByTestId("recording-bulk-merge").click();

        const items = page.getByTestId("merge-item");
        await expect(items).toHaveCount(2);
        await page.getByTestId("merge-order-import").click();
        await expect(page.getByTestId("merge-order-import")).toHaveAttribute(
            "aria-pressed",
            "true",
        );
        await expect(items.first()).toContainText(titles[0]);
        await expect(page.getByTestId("merge-title")).toHaveValue(
            `${titles[0]} (merged)`,
        );
        await items.first().getByTestId("merge-move-down").click();
        await expect(items.first()).toContainText(titles[1]);
        await expect(page.getByText("Custom order")).toBeVisible();

        const merged = "E2E merged recording";
        await page.getByTestId("merge-title").fill(merged);
        await page.getByTestId("merge-delete-originals").check();
        await page.getByTestId("merge-confirm").click();

        const list = page.getByTestId("recording-list");
        const row = page
            .getByTestId("recording-row")
            .filter({ hasText: merged });
        await expect(row).toBeVisible();
        for (const title of titles) await expect(list).not.toContainText(title);

        const id = await row.getAttribute("data-id");
        const detail = await page.request.get(`/api/recordings/${id}`);
        const { recording } = await detail.json();
        // Two one-second clips.
        expect(recording.duration).toBeGreaterThan(1900);
        expect(recording.duration).toBeLessThan(2100);
        expect((await page.request.delete(`/api/recordings/${id}`)).ok()).toBe(
            true,
        );
    });
});
