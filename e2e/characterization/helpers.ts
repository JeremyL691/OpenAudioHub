import { expect, type Page } from "@playwright/test";

// Seeded by scripts/dev/seed-e2e.ts. Names are the visible recording titles.
export const RECORDINGS = {
    weekly: "Weekly team sync",
    long: "Long lecture (10 min)",
    plaudDraft: "Plaud import draft",
    needsAlignment: "Needs alignment",
    processing: "Processing now",
    untranscribed: "Untranscribed memo",
} as const;

// Reuses the stored session from global setup (e2e/global-setup.ts). Signs in
// through the form only when the stored session is missing or expired, because
// Better Auth rate-limits repeated sign-ins from one client.
export async function signIn(page: Page): Promise<void> {
    await page.goto("/recordings");
    if (new URL(page.url()).pathname.startsWith("/login")) {
        await page.getByLabel("Email").fill(process.env.E2E_EMAIL ?? "");
        await page.getByLabel("Password").fill(process.env.E2E_PASSWORD ?? "");
        await page.getByRole("button", { name: /sign in|log ?in/i }).click();
        // Login lands on the overview; the specs that follow work in the library.
        await page.waitForURL("**/dashboard");
        await page.goto("/recordings");
    }
    await expect(page.getByTestId("recording-list")).toBeVisible();
}

export async function openRecording(page: Page, title: string): Promise<void> {
    await page
        .getByTestId("recording-row")
        .filter({ hasText: title })
        .getByRole("button")
        .first()
        .click();
    await expect(page.getByTestId("player")).toContainText(title);
}
