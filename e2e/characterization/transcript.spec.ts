import { expect, test } from "@playwright/test";
import { openRecording, RECORDINGS, signIn } from "./helpers";

test.describe("transcript and summary", () => {
    test.beforeEach(async ({ page }) => {
        await signIn(page);
    });

    test("clicking a timeline segment seeks and highlights it", async ({
        page,
    }) => {
        await openRecording(page, RECORDINGS.long);

        const segment = page.getByTestId("transcript-segment").nth(3);
        await expect(segment).toHaveAttribute("data-start-ms", "45000");
        await segment.click();

        await expect(page.getByTestId("player-time")).toContainText("0:45");
        await expect(segment).toHaveAttribute("data-active", "true");
    });

    test("switches between transcript sources", async ({ page }) => {
        // The source switcher renders on the full detail page (/recordings/[id]),
        // not in the dashboard detail pane.
        const id = await page
            .getByTestId("recording-row")
            .filter({ hasText: RECORDINGS.weekly })
            .getAttribute("data-id");
        await page.goto(`/recordings/${id}`);

        const switcher = page.getByTestId("source-switcher");
        await expect(switcher).toBeVisible();
        await switcher.getByRole("button", { name: "Your provider" }).click();
        await expect(page.getByTestId("transcript-timeline")).toBeVisible();

        await switcher.getByRole("button", { name: "Plaud" }).click();
        await expect(page.getByTestId("transcript-timeline")).toHaveCount(0);

        await switcher.getByRole("button", { name: "Your provider" }).click();
        await expect(page.getByTestId("transcript-timeline")).toBeVisible();
    });

    test("generates a summary for a transcript that has none", async ({
        page,
    }) => {
        await openRecording(page, RECORDINGS.plaudDraft);

        await page.getByTestId("summary-generate").click();

        const expand = page.getByRole("button", { name: "Expand summary" });
        await expect(
            expand.or(page.getByTestId("summary-content")),
        ).toBeVisible({ timeout: 60_000 });
        if (await expand.isVisible()) await expand.click();
        await expect(page.getByTestId("summary-content")).toContainText(
            "roadmap",
        );
    });
});
