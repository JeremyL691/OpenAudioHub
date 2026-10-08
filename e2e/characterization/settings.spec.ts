import { expect, type Page, test } from "@playwright/test";
import { signIn } from "./helpers";

const SECTIONS = [
    ["providers", "Providers"],
    ["transcription", "Transcription"],
    ["summary", "Summary"],
    ["plaud-account", "Plaud Account"],
    ["sync", "Sync"],
    ["playback", "Playback"],
    ["display", "Display"],
    ["notifications", "Notifications"],
    ["storage", "Storage"],
    ["export", "Export/Backup"],
    ["api-keys", "API Keys"],
    ["webhooks", "Webhooks"],
] as const;

async function openSettings(page: Page): Promise<void> {
    await page.getByTestId("user-menu").click();
    await page.getByRole("menuitem", { name: "Settings" }).click();
    await expect(page.getByTestId("settings-nav")).toBeVisible();
}

async function openSection(page: Page, name: string): Promise<void> {
    await page.getByRole("link", { name: `${name} settings` }).click();
}

test.describe("settings", () => {
    test.beforeEach(async ({ page }) => {
        await signIn(page);
        await openSettings(page);
    });

    test("opens every section from the settings navigation", async ({
        page,
    }) => {
        for (const [id, name] of SECTIONS) {
            await openSection(page, name);
            await expect(
                page.getByTestId(`settings-section-${id}`),
            ).toBeVisible();
        }
    });

    test("creates an API key and revokes it", async ({ page }) => {
        const keyName = "E2E created key";
        await openSection(page, "API Keys");

        await page.getByTestId("api-key-create").first().click();
        const dialog = page.getByRole("dialog", { name: "Create API Key" });
        await dialog.getByLabel("Name").fill(keyName);
        await dialog
            .getByRole("button", { name: "Create", exact: true })
            .click();

        await expect(dialog).toContainText("This key is shown once.");
        await dialog.getByRole("button", { name: "Saved" }).click();
        await expect(dialog).toHaveCount(0);

        await expect(
            page.getByRole("heading", { name: keyName }),
        ).toBeVisible();
        await page.getByRole("button", { name: `Revoke ${keyName}` }).click();
        await expect(page.getByText("Revoked", { exact: true })).toBeVisible();
    });

    test("creates a webhook", async ({ page }) => {
        const description = "E2E created webhook";
        await openSection(page, "Webhooks");

        await page.getByTestId("webhook-create").first().click();
        const dialog = page.getByRole("dialog");
        await dialog.getByLabel("URL").fill("http://127.0.0.1:3299/created");
        await dialog.getByLabel("Description").fill(description);
        await dialog
            .getByRole("button", { name: /create|save/i })
            .last()
            .click();

        await expect(page.getByText(description)).toBeVisible();
    });

    test("re-runs onboarding and restores the completed flag", async ({
        page,
    }) => {
        await openSection(page, "Export/Backup");
        await page.getByRole("button", { name: "Re-run Onboarding" }).click();
        await expect(page.getByTestId("onboarding-dialog")).toBeVisible();

        const restored = await page.request.put("/api/settings/user", {
            data: { onboardingCompleted: true },
        });
        expect(restored.ok()).toBeTruthy();
    });
});
