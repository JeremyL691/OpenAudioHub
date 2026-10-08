import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { openRecording, RECORDINGS, signIn } from "./characterization/helpers";

// Read-only checks for the 2026-10-08 feedback. Deleting a transcript is
// covered by unit tests, because the seeded recordings are shared by other specs.

test("the docs page links back to the app", async ({ page }) => {
    await signIn(page);
    await page.goto("/docs");
    await page.getByRole("link", { name: "Back to app" }).first().click();
    await expect(page).toHaveURL(/\/dashboard$/);
});

test("the transcript downloads as TXT and JSON", async ({ page }) => {
    await signIn(page);
    await openRecording(page, RECORDINGS.weekly);
    const txt = page.waitForEvent("download");
    await page
        .getByRole("button", { name: "Download transcript as TXT" })
        .first()
        .click();
    expect((await txt).suggestedFilename()).toBe("Weekly team sync.txt");

    const json = page.waitForEvent("download");
    await page
        .getByRole("button", { name: "Download transcript as JSON" })
        .first()
        .click();
    expect((await json).suggestedFilename()).toBe("Weekly team sync.json");
});

test("the summary downloads as Markdown and TXT", async ({ page }) => {
    await signIn(page);
    await openRecording(page, RECORDINGS.weekly);
    const panel = page.getByTestId("summary-panel");
    await expect(panel.getByTestId("summary-content")).toBeVisible();

    const markdown = page.waitForEvent("download");
    await panel
        .getByRole("button", { name: "Download summary as Markdown" })
        .click();
    const md = await markdown;
    expect(md.suggestedFilename()).toBe("Weekly team sync summary.md");
    expect(await readFile((await md.path()) as string, "utf8")).toMatch(
        /^# Weekly team sync/,
    );

    const plain = page.waitForEvent("download");
    await panel
        .getByRole("button", { name: "Download summary as TXT" })
        .click();
    expect((await plain).suggestedFilename()).toBe(
        "Weekly team sync summary.txt",
    );
});

test("the summary offers a language and a template", async ({ page }) => {
    await signIn(page);
    await openRecording(page, RECORDINGS.weekly);
    const panel = page.getByTestId("summary-panel");
    await expect(
        panel.getByRole("combobox", { name: "Summary language" }),
    ).toContainText("Auto (match transcript)");
    await expect(
        panel.getByRole("combobox", { name: "Summary prompt" }),
    ).toBeVisible();
});
