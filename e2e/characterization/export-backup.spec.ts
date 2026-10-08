import { expect, type Page, test } from "@playwright/test";
import { signIn } from "./helpers";

// Formats served by GET /api/export. The settings UI offers the same four, and
// /api/settings/user accepts the same four as the saved default (B-001, D-201;
// before that the validator accepted json, csv, and zip, so TXT was reverted).
const EXPORT_FORMATS = ["json", "txt", "srt", "vtt"] as const;

async function openExportSection(page: Page): Promise<void> {
    await page.getByTestId("user-menu").click();
    await page.getByRole("menuitem", { name: "Settings" }).click();
    await page.getByRole("link", { name: "Export/Backup settings" }).click();
    await expect(page.getByTestId("export-format")).toBeVisible();
}

test.describe("export and backup", () => {
    test.beforeEach(async ({ page }) => {
        await signIn(page);
        await openExportSection(page);
    });

    // Other tests expect JSON as the default, so put it back after each test.
    test.afterEach(async ({ page }) => {
        const response = await page.request.put("/api/settings/user", {
            data: { defaultExportFormat: "json" },
        });
        expect(response.ok()).toBeTruthy();
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

    test("selecting TXT saves it as the default export format", async ({
        page,
    }) => {
        await page.getByTestId("export-format").click();
        const saved = page.waitForResponse(
            (res) =>
                new URL(res.url()).pathname === "/api/settings/user" &&
                res.request().method() === "PUT",
        );
        await page.getByRole("option", { name: /^TXT\b/ }).click();
        expect((await saved).ok()).toBeTruthy();
        await expect(page.getByTestId("export-format")).toContainText("TXT");

        await page.reload();
        await expect(page.getByTestId("export-format")).toContainText("TXT");

        const request = page.waitForRequest(
            (req) =>
                new URL(req.url()).pathname === "/api/export" &&
                new URL(req.url()).searchParams.get("format") === "txt",
        );
        await page.getByRole("button", { name: "Export text" }).click();
        await request;
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
