import { expect, type Page, test } from "@playwright/test";
import { RECORDINGS, signIn } from "../characterization/helpers";

// Regression guard for defect fix ① (T5.3b): the full recording page wires its
// timeline to the player. A click seeks the audio, the highlight moves with the
// playback position, and with Follow playback on the active segment stays in view.

// Opens the seeded long recording on the full page, once its audio has metadata.
async function openLongRecording(page: Page): Promise<void> {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/recordings");
    await expect(page.getByTestId("recording-list")).toBeVisible();
    const id = await page
        .getByTestId("recording-row")
        .filter({ hasText: RECORDINGS.long })
        .getAttribute("data-id");
    await page.goto(`/recordings/${id}`);
    await expect(page.getByTestId("player")).toBeVisible();
    // A seek only takes effect once the audio element has its metadata.
    await expect
        .poll(() =>
            page
                .locator("audio")
                .evaluate((el: HTMLAudioElement) => el.readyState),
        )
        .toBeGreaterThanOrEqual(1);
}

// The audio element's playback position, in seconds.
function audioTime(page: Page): Promise<number> {
    return page
        .locator("audio")
        .evaluate((el: HTMLAudioElement) => el.currentTime);
}

// True when the active segment sits fully inside the transcript's scroll area.
function activeSegmentInView(page: Page): Promise<boolean> {
    return page
        .getByTestId("transcript-timeline")
        .evaluate((list: HTMLElement) => {
            const area = list.parentElement;
            const active = list.querySelector<HTMLElement>(
                '[data-active="true"]',
            );
            if (!area || !active) return false;
            const top = active.offsetTop - area.scrollTop;
            return top >= 0 && top + active.offsetHeight <= area.clientHeight;
        });
}

test.describe("detail timeline seek (regression)", () => {
    test.beforeEach(async ({ page }) => {
        await signIn(page);
    });

    test("a click seeks the audio element to the segment's start", async ({
        page,
    }) => {
        await openLongRecording(page);

        const segment = page.getByTestId("transcript-segment").nth(3);
        await expect(segment).toHaveAttribute("data-start-ms", "45000");
        await segment.click();

        await expect.poll(() => audioTime(page)).toBeCloseTo(45, 0);
    });

    test("the highlight moves to the segment that was clicked", async ({
        page,
    }) => {
        await openLongRecording(page);

        const segments = page.getByTestId("transcript-segment");
        await segments.nth(1).click();
        await expect(segments.nth(1)).toHaveAttribute("data-active", "true");

        await segments.nth(5).click();
        await expect(segments.nth(5)).toHaveAttribute("data-active", "true");
        await expect(segments.nth(1)).toHaveAttribute("data-active", "false");
        await expect(
            page.locator(
                '[data-testid="transcript-segment"][data-active="true"]',
            ),
        ).toHaveCount(1);
    });

    test("with Follow playback on, the active segment is kept in view", async ({
        page,
    }) => {
        await openLongRecording(page);

        const last = page.getByTestId("transcript-segment").last();
        await last.click();
        await expect(last).toHaveAttribute("data-active", "true");

        // The transcript scrolls its own area smoothly, so poll until it settles.
        await expect.poll(() => activeSegmentInView(page)).toBe(true);
    });
});
