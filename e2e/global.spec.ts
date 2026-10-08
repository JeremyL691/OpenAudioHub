import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { signIn } from "./characterization/helpers";

// SHOT_SET (for example "after") also writes captures of the palette and the
// onboarding dialog to .dev-artifacts/screenshots/<SHOT_SET>/, for review.
const SHOT_SET = process.env.SHOT_SET;
const PALETTE_INPUT = "Search recordings, transcripts, or actions…";

async function capture(page: Page, name: string): Promise<void> {
    if (!SHOT_SET) return;
    const outDir = path.resolve(
        __dirname,
        "../.dev-artifacts/screenshots",
        SHOT_SET,
    );
    mkdirSync(outDir, { recursive: true });
    await page.screenshot({ path: path.join(outDir, `${name}.png`) });
}

test.describe("global components", () => {
    test.beforeEach(async ({ page }) => {
        await signIn(page);
    });

    // Re-running onboarding sets the completed flag to false, which opens a
    // mandatory onboarding dialog on every page. Restore the flag so the
    // specs that run after this one see a finished account.
    test.afterEach(async ({ page }) => {
        const restored = await page.request.put("/api/settings/user", {
            data: { onboardingCompleted: true },
        });
        expect(restored.ok()).toBeTruthy();
    });

    test("the command palette runs a theme action", async ({ page }) => {
        await page.goto("/recordings");
        await expect(page.getByTestId("recording-list")).toBeVisible();

        await page.keyboard.press("ControlOrMeta+k");
        const palette = page.getByRole("dialog", { name: "Command palette" });
        await expect(palette).toBeVisible();
        await expect(
            palette.getByText("Actions", { exact: true }),
        ).toBeVisible();
        // Let the dialog finish its fade-in before the capture.
        await page.waitForTimeout(400);
        await capture(page, "palette-1280-light");

        await palette.getByPlaceholder(PALETTE_INPUT).fill("Dark");
        await palette.getByRole("option", { name: "Dark" }).click();
        await expect(page.locator("html")).toHaveClass(/\bdark\b/);

        // Put the theme back so later tests see the default.
        await page.keyboard.press("ControlOrMeta+k");
        const again = page.getByRole("dialog", { name: "Command palette" });
        await again.getByPlaceholder(PALETTE_INPUT).fill("Auto");
        await again.getByRole("option", { name: "Auto" }).click();
        await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
    });

    test("the shortcuts dialog lists the keys and closes", async ({ page }) => {
        await page.goto("/recordings");
        await expect(page.getByTestId("recording-list")).toBeVisible();

        await page.keyboard.press("?");
        const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
        await expect(dialog).toBeVisible();
        await expect(
            dialog.getByText("Command palette", { exact: true }),
        ).toBeVisible();

        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
    });

    test("the onboarding dialog shows its four steps", async ({ page }) => {
        await page.goto("/settings/export");
        await page.getByRole("button", { name: "Re-run Onboarding" }).click();

        const dialog = page.getByTestId("onboarding-dialog");
        await expect(dialog).toBeVisible();
        const progress = dialog.getByRole("progressbar", {
            name: "Onboarding progress",
        });
        await expect(progress).toHaveAttribute("aria-valuetext", "Step 1 of 4");
        await capture(page, "onboarding-step1-1280-light");

        await dialog.getByRole("button", { name: "Next" }).click();
        await expect(progress).toHaveAttribute("aria-valuetext", "Step 2 of 4");
        await capture(page, "onboarding-step2-1280-light");

        // Re-running onboarding stays dismissible.
        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
    });
});
