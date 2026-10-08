import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test.describe("shortcuts and command palette", () => {
    test.beforeEach(async ({ page }) => {
        await signIn(page);
        await page.locator("body").click();
    });

    test("? opens the keyboard shortcuts dialog", async ({ page }) => {
        await page.keyboard.press("?");
        await expect(
            page.getByRole("dialog", { name: "Keyboard shortcuts" }),
        ).toBeVisible();
    });

    test("/ focuses the recording search", async ({ page }) => {
        await page.keyboard.press("/");
        await expect(page.getByTestId("recording-search")).toBeFocused();
    });

    test("Ctrl or Cmd+K opens the command palette", async ({ page }) => {
        await page.keyboard.press("ControlOrMeta+k");
        await expect(
            page.getByRole("dialog", { name: "Command palette" }),
        ).toBeVisible();
    });

    test("the command trigger opens the palette", async ({ page }) => {
        await page.getByTestId("command-trigger").click();
        await expect(
            page.getByRole("dialog", { name: "Command palette" }),
        ).toBeVisible();
    });

    test(", opens settings", async ({ page }) => {
        await page.keyboard.press(",");
        await expect(page.getByTestId("settings-nav")).toBeVisible();
    });
});
