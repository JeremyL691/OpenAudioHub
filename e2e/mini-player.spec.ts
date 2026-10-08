import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { openRecording, RECORDINGS, signIn } from "./characterization/helpers";

// SHOT_SET (for example "after") writes captures of the compact bar and of the
// player card to .dev-artifacts/screenshots/<SHOT_SET>/. Without it they are skipped.
const SHOT_SET = process.env.SHOT_SET;

// Scrolls the nearest scrolling ancestor of the player, or the window, by deltaY
// pixels. Playwright's hover or click would scroll the player back into view, so
// the scroll runs on the element instead. It is instant: the page uses
// `scroll-behavior: smooth`, and a capture taken mid-animation shows the sticky
// top bar out of place.
async function scrollPlayer(page: Page, deltaY: number): Promise<void> {
    await page.getByTestId("player").evaluate((card, delta) => {
        let node: HTMLElement | null = card.parentElement;
        while (
            node &&
            !/(auto|scroll)/.test(getComputedStyle(node).overflowY)
        ) {
            node = node.parentElement;
        }
        const options = { top: delta, behavior: "instant" as const };
        if (node) node.scrollBy(options);
        else window.scrollBy(options);
    }, deltaY);
}

// The transcript and summary load after the player shows, and the page is shorter
// than the viewport plus the player on tall screens. Wait until the bottom of the
// player can be scrolled past the top of the viewport. A test that scrolls the
// player away calls this first.
async function waitForScrollableDocument(page: Page): Promise<void> {
    await page.waitForFunction(() => {
        const card = document.querySelector('[data-testid="player"]');
        if (!card) return false;
        const cardBottom = card.getBoundingClientRect().bottom + window.scrollY;
        return (
            document.documentElement.scrollHeight - window.innerHeight >
            cardBottom
        );
    });
}

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

test.describe("mini player", () => {
    test.beforeEach(async ({ page }) => {
        await signIn(page);
        await openRecording(page, RECORDINGS.long);
    });

    test("stays out of the way while the full player is on screen", async ({
        page,
    }) => {
        await expect(page.getByTestId("player")).toBeInViewport();
        await expect(page.getByTestId("mini-player")).toHaveCount(0);
    });

    test("pins under the top bar once the player scrolls away", async ({
        page,
    }) => {
        await scrollPlayer(page, 1500);

        const mini = page.getByTestId("mini-player");
        await expect(mini).toBeVisible();
        await expect(mini).toContainText(RECORDINGS.long);

        const topbar = await page.getByTestId("topbar").boundingBox();
        const pinned = await mini.boundingBox();
        if (!topbar || !pinned) {
            throw new Error("top bar or mini player has no bounding box");
        }
        // Directly under the top bar and inside the content column, so the
        // sidebar is not covered.
        expect(
            Math.abs(pinned.y - (topbar.y + topbar.height)),
        ).toBeLessThanOrEqual(1);
        expect(Math.abs(pinned.x - topbar.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(pinned.width - topbar.width)).toBeLessThanOrEqual(1);
    });

    test("plays and pauses the same recording from the bar", async ({
        page,
    }) => {
        await scrollPlayer(page, 1500);

        const mini = page.getByTestId("mini-player");
        await mini.getByRole("button", { name: "Play" }).click();
        await expect(page.getByTestId("player-play")).toHaveAttribute(
            "aria-label",
            "Pause",
        );
        await expect(page.getByTestId("player-time")).not.toContainText(
            /^0:00 /,
        );

        await mini.getByRole("button", { name: "Pause" }).click();
        await expect(page.getByTestId("player-play")).toHaveAttribute(
            "aria-label",
            "Play",
        );
    });

    test("goes away once the full player is back on screen", async ({
        page,
    }) => {
        await scrollPlayer(page, 1500);
        await expect(page.getByTestId("mini-player")).toBeVisible();

        await scrollPlayer(page, -5000);
        await expect(page.getByTestId("player")).toBeInViewport();
        await expect(page.getByTestId("mini-player")).toHaveCount(0);
    });

    test("the full recording page gets the same bar", async ({ page }) => {
        // The two-column page is shorter than a tall window, so use a shorter
        // viewport for the player to be able to scroll out of view.
        await page.setViewportSize({ width: 1280, height: 600 });
        await page.getByTestId("open-full-view").click();
        await expect(page.getByTestId("player")).toBeVisible();
        await waitForScrollableDocument(page);

        await scrollPlayer(page, 1500);
        await expect(page.getByTestId("mini-player")).toBeVisible();
    });
});

test.describe("mini player captures", () => {
    test.skip(!SHOT_SET, "set SHOT_SET to write captures");

    const outDir = () =>
        path.resolve(
            __dirname,
            "../.dev-artifacts/screenshots",
            SHOT_SET ?? "",
        );

    for (const width of [375, 1280] as const) {
        for (const scheme of ["light", "dark"] as const) {
            test(`compact bar at ${width}px in ${scheme} mode`, async ({
                page,
            }) => {
                // The long recording's page is taller than this viewport, so the
                // player can scroll out of view.
                await page.setViewportSize({ width, height: 560 });
                await page.emulateMedia({ colorScheme: scheme });
                await signIn(page);
                await openFullPage(page, RECORDINGS.long);
                await waitForScrollableDocument(page);

                await scrollPlayer(page, 1500);
                await expect(page.getByTestId("mini-player")).toBeVisible();
                mkdirSync(outDir(), { recursive: true });
                await page.screenshot({
                    path: path.join(
                        outDir(),
                        `mini-player-${width}-${scheme}.png`,
                    ),
                });
            });

            test(`player with a played waveform at ${width}px in ${scheme} mode`, async ({
                page,
            }) => {
                await page.setViewportSize({ width, height: 800 });
                await page.emulateMedia({ colorScheme: scheme });
                await signIn(page);
                // The short recording decodes its waveform, so the played part can be
                // shown. The long one waits for a manual decode.
                await openFullPage(page, RECORDINGS.weekly);
                await expect(page.getByTestId("player-time")).toContainText(
                    "0:01",
                );

                // Seek to the middle so the played part of the waveform is drawn.
                const waveform = page
                    .getByTestId("player-scrubber")
                    .getByRole("slider");
                const box = await waveform.boundingBox();
                if (!box) {
                    throw new Error("waveform has no bounding box");
                }
                await page.mouse.click(
                    box.x + box.width / 2,
                    box.y + box.height / 2,
                );
                await expect(waveform).toHaveAttribute(
                    "aria-valuenow",
                    /^(4[5-9]|5[0-5])$/,
                );

                mkdirSync(outDir(), { recursive: true });
                await page.getByTestId("player").screenshot({
                    path: path.join(outDir(), `player-${width}-${scheme}.png`),
                });
            });
        }
    }
});
