import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { RECORDINGS, signIn } from "./characterization/helpers";

// Opens the full recording page (/recordings/[id]) for a seeded recording.
async function openFullPage(page: Page, title: string): Promise<void> {
    await page.goto("/recordings");
    await expect(page.getByTestId("recording-list")).toBeVisible();
    const id = await page
        .getByTestId("recording-row")
        .filter({ hasText: title })
        .getAttribute("data-id");
    await page.goto(`/recordings/${id}`);
    await expect(page.getByTestId("player")).toBeVisible();
}

test.describe("recording detail", () => {
    test.beforeEach(async ({ page }) => {
        await signIn(page);
    });

    test("puts the transcript beside the summary and details from xl up", async ({
        page,
    }) => {
        await page.setViewportSize({ width: 1280, height: 800 });
        await openFullPage(page, RECORDINGS.long);

        await expect(page.getByRole("tablist")).toBeHidden();
        const panels = page.locator('[role="tabpanel"]');
        const transcript = await panels.nth(0).boundingBox();
        const summary = await panels.nth(1).boundingBox();
        const details = await panels.nth(2).boundingBox();
        if (!transcript || !summary || !details) {
            throw new Error("a section has no bounding box");
        }

        // Transcript in the left column; summary above details in the right one.
        expect(summary.x).toBeGreaterThan(transcript.x + transcript.width - 1);
        expect(Math.abs(summary.y - transcript.y)).toBeLessThanOrEqual(2);
        expect(details.y).toBeGreaterThan(summary.y);
        expect(Math.abs(details.x - summary.x)).toBeLessThanOrEqual(2);
    });

    test("uses tabs below xl", async ({ page }) => {
        await page.setViewportSize({ width: 900, height: 800 });
        await openFullPage(page, RECORDINGS.long);

        await expect(page.getByRole("tablist")).toBeVisible();
        await expect(page.getByTestId("transcript-timeline")).toBeVisible();
        await expect(page.getByTestId("summary-panel")).toBeHidden();

        await page.getByRole("tab", { name: "Summary" }).click();
        await expect(page.getByTestId("summary-panel")).toBeVisible();
        await expect(page.getByTestId("transcript-timeline")).toBeHidden();

        await page.getByRole("tab", { name: "Details" }).click();
        await expect(
            page.getByRole("button", { name: "Collapse" }),
        ).toBeVisible();
    });

    test("clicking a timeline segment seeks the player on the full page", async ({
        page,
    }) => {
        await page.setViewportSize({ width: 1280, height: 800 });
        await openFullPage(page, RECORDINGS.long);

        const segment = page.getByTestId("transcript-segment").nth(3);
        await expect(segment).toHaveAttribute("data-start-ms", "45000");
        await segment.click();

        await expect(page.getByTestId("player-time")).toContainText("0:45");
        await expect(segment).toHaveAttribute("data-active", "true");
    });

    test("follow playback can be switched off", async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 800 });
        await openFullPage(page, RECORDINGS.long);

        const follow = page.getByRole("switch", { name: "Follow playback" });
        await expect(follow).toHaveAttribute("aria-checked", "true");
        await follow.click();
        await expect(follow).toHaveAttribute("aria-checked", "false");
    });

    test("the actions menu exports the transcript as a text file", async ({
        page,
    }) => {
        await page.setViewportSize({ width: 1280, height: 800 });
        await openFullPage(page, RECORDINGS.long);

        await page.getByRole("button", { name: "Recording actions" }).click();
        await expect(
            page.getByRole("menuitem", { name: "Export SRT" }),
        ).toBeEnabled();
        await expect(
            page.getByRole("menuitem", { name: "Re-transcribe" }),
        ).toBeVisible();

        const download = page.waitForEvent("download");
        await page.getByRole("menuitem", { name: "Export TXT" }).click();
        const file = await download;
        expect(file.suggestedFilename()).toBe("Long lecture (10 min).txt");

        const path = await file.path();
        if (!path) throw new Error("the download has no local path");
        expect(readFileSync(path, "utf8")).toContain(
            "Segment 1 of the long lecture covers topic 1.",
        );
    });
});
