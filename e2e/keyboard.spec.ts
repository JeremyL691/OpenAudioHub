import { expect, type Page, test } from "@playwright/test";
import { RECORDINGS, signIn } from "./characterization/helpers";

// Keyboard-only flows. Each step uses keys, not the pointer.

// Opens the seeded long recording on the full page and waits for its audio.
async function openLongRecordingByKeyboard(page: Page): Promise<void> {
    await page.goto("/recordings");
    await expect(page.getByTestId("recording-list")).toBeVisible();
    const id = await page
        .getByTestId("recording-row")
        .filter({ hasText: RECORDINGS.long })
        .getAttribute("data-id");
    await page.goto(`/recordings/${id}`);
    await expect(page.getByTestId("player")).toBeVisible();
    // Keys act on the page only once the audio has metadata to play.
    await expect
        .poll(() =>
            page
                .locator("audio")
                .evaluate((el: HTMLAudioElement) => el.readyState),
        )
        .toBeGreaterThanOrEqual(1);
}

test.describe("keyboard flows, signed out", () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test("signs in with the keyboard only", async ({ page }) => {
        await page.goto("/login");
        await page.getByLabel("Email").focus();
        await page.keyboard.type(process.env.E2E_EMAIL ?? "");
        await page.keyboard.press("Tab");
        await page.keyboard.type(process.env.E2E_PASSWORD ?? "");
        await page.keyboard.press("Enter");
        await page.waitForURL("**/dashboard");
    });
});

test.describe("keyboard flows, signed in", () => {
    test.beforeEach(async ({ page }) => {
        await signIn(page);
    });

    test("the command palette opens and a recording is chosen with the keys", async ({
        page,
    }) => {
        await page.goto("/recordings");
        await expect(page.getByTestId("recording-list")).toBeVisible();

        await page.keyboard.press("ControlOrMeta+k");
        await expect(page.getByRole("dialog")).toBeVisible();
        await page.keyboard.type("Weekly team");
        await page.keyboard.press("Enter");

        await expect(page.getByRole("dialog")).toBeHidden();
        await expect(page.getByTestId("player")).toContainText(
            RECORDINGS.weekly,
        );
    });

    test("Space plays and pauses the open recording", async ({ page }) => {
        await openLongRecordingByKeyboard(page);
        const paused = () =>
            page.locator("audio").evaluate((el: HTMLAudioElement) => el.paused);

        await page.keyboard.press(" ");
        await expect.poll(() => paused()).toBe(false);

        await page.keyboard.press(" ");
        await expect.poll(() => paused()).toBe(true);
    });

    test("the arrow keys seek five seconds at a time", async ({ page }) => {
        await openLongRecordingByKeyboard(page);
        const time = () =>
            page
                .locator("audio")
                .evaluate((el: HTMLAudioElement) => el.currentTime);
        const start = await time();

        await page.keyboard.press("ArrowRight");
        await expect.poll(() => time()).toBeGreaterThan(start + 4);

        await page.keyboard.press("ArrowLeft");
        await expect.poll(() => time()).toBeLessThan(start + 2);
    });

    test("? opens the keyboard shortcuts, and Escape closes them", async ({
        page,
    }) => {
        await page.goto("/recordings");
        await expect(page.getByTestId("recording-list")).toBeVisible();

        await page.keyboard.type("?");
        const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
        await expect(dialog).toBeVisible();

        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
    });
});
