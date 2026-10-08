import { expect, type Page, test } from "@playwright/test";
import { signIn } from "./helpers";

// Formats served by GET /api/export. The settings UI offers the same four, but
// the default-format validator in /api/settings/user accepts only json, csv, and
// zip. Selecting txt, srt, or vtt in the UI is rejected and reverted. That is the
// current behavior this file characterizes; see docs/dev/BLOCKERS.md.
const EXPORT_FORMATS = ["json", "txt", "srt", "vtt"] as const;

async function openExportSection(page: Page): Promise<void> {
    await page.getByTestId("user-menu").click();
    await page.getByRole("menuitem", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Export/Backup settings" }).click();
    await expect(page.getByTestId("export-format")).toBeVisible();
}

test.describe("export and backup", () => {
    test.beforeEach(async ({ page }) => {
        await signIn(page);
        await openExportSection(page);
    });

    test("Export text downloads the default JSON format", async ({ page }) => {
        const request = page.waitForRequest(
            (req) =>
                new URL(req.url()).pathname === "/api/export" &&
                new URL(req.url()).searchParams.get("format") === "json",
        );
        await page.getByRole("button", { name: "Export text" }).click();
        await request;
    });

    test("selecting TXT in the UI is rejected and reverts to JSON", async ({
        page,
    }) => {
        await page.getByTestId("export-format").click();
        await page.getByRole("option", { name: /^TXT\b/ }).click();

        // Only the root layout mounts a Toaster (the duplicate in (app)/layout.tsx
        // was removed in T4.2), so the message renders once.
        const message = page.getByText(
            "Failed to save settings. Changes reverted.",
        );
        await expect(message).toHaveCount(1);
        await expect(message).toBeVisible();
        await expect(page.getByTestId("export-format")).toContainText("JSON");
    });

    for (const format of EXPORT_FORMATS) {
        test(`GET /api/export serves the ${format} format`, async ({
            page,
        }) => {
            const response = await page.request.get(
                `/api/export?format=${format}`,
            );
            expect(response.status()).toBe(200);
            expect((await response.body()).byteLength).toBeGreaterThan(0);
        });
    }

    test("starts a full backup", async ({ page }) => {
        const started = page.waitForResponse(
            (res) =>
                new URL(res.url()).pathname === "/api/backup" &&
                res.request().method() === "POST",
        );
        await page.getByTestId("backup-start").click();

        expect((await started).ok()).toBeTruthy();
    });
});
