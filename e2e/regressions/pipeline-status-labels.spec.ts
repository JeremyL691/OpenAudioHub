import { expect, type Page, test } from "@playwright/test";
import { RECORDINGS, signIn } from "../characterization/helpers";

// F25: the two pipeline outcomes that tell the user what to do next. The jobs are
// seeded by scripts/dev/seed-e2e.ts.
// - The recording page shows the outcome in its pipeline status block, which carries the
//   job phase in data-phase (src/components/recording/pipeline/pipeline-status.tsx).
// - The overview's Processing card lists paused jobs with the badge label from
//   src/components/app/status-badge.tsx.
// The library row shows the transcript state only, so it is not asserted here.
// The recording page shows one pipeline status per job (recording-workstation.tsx hides its
// banner while the transcript card shows the state), so each detail test also asserts a count of one.

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

test.describe("pipeline outcomes (F25)", () => {
    test.beforeEach(async ({ page }) => {
        await signIn(page);
    });

    test("a recording saved without timestamps says playback positioning is unavailable", async ({
        page,
    }) => {
        await openFullPage(page, RECORDINGS.needsAlignment);
        await expect(page.getByTestId("pipeline-status")).toHaveCount(1);
        const status = page.getByTestId("pipeline-status");
        await expect(status).toHaveAttribute("data-phase", "needs_alignment");
        await expect(status).toContainText(
            "playback positioning is unavailable",
        );
    });

    test("a recording paused for disk space says the pipeline will resume", async ({
        page,
    }) => {
        await openFullPage(page, RECORDINGS.pausedDisk);
        await expect(page.getByTestId("pipeline-status")).toHaveCount(1);
        const status = page.getByTestId("pipeline-status");
        await expect(status).toHaveAttribute("data-phase", "paused_disk");
        await expect(status).toContainText("needs more disk space");
    });

    test("the overview's Processing card labels a recording paused for disk space", async ({
        page,
    }) => {
        await page.goto("/dashboard");
        const processing = page.getByRole("region", { name: "Processing" });
        await expect(
            processing.getByRole("link", { name: RECORDINGS.pausedDisk }),
        ).toBeVisible();
        await expect(processing).toContainText("Paused for disk space");
    });
});
