import { expect, test } from "@playwright/test";
import { openRecording, RECORDINGS, signIn } from "./helpers";

test.describe("player", () => {
    test.beforeEach(async ({ page }) => {
        await signIn(page);
        await openRecording(page, RECORDINGS.long);
    });

    test("plays and pauses from the transport button", async ({ page }) => {
        const play = page.getByTestId("player-play");
        await expect(play).toHaveAttribute("aria-label", "Play");

        await play.click();
        await expect(play).toHaveAttribute("aria-label", "Pause");
        await expect(page.getByTestId("player-time")).not.toContainText(
            /^0:00 /,
        );

        await play.click();
        await expect(play).toHaveAttribute("aria-label", "Play");
    });

    test("cycles the playback speed", async ({ page }) => {
        const speed = page.getByTestId("player-speed");
        const before = await speed.textContent();

        await speed.click();
        await expect(speed).not.toHaveText(before ?? "");
    });

    test("clicking the scrubber seeks to the matching position", async ({
        page,
    }) => {
        const scrubber = page.getByTestId("player-scrubber");
        await expect(scrubber).toBeVisible();
        const box = await scrubber.boundingBox();
        if (!box) throw new Error("scrubber has no bounding box");

        await page.mouse.click(box.x + box.width * 0.5, box.y + box.height / 2);

        await expect(page.getByTestId("player-time")).toContainText(
            /0?[45]:[0-5]\d\s*\/\s*10:00/,
        );
    });
});
