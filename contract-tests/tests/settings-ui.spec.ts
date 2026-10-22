import { expect, test } from "@playwright/test";
import { baseURL, clientHeaders, newUserContext } from "../helpers/api";

test("summary settings save custom prompts through user settings", async ({ browser }) => {
    const api = await newUserContext("settings-ui-prompts");
    try {
        await api.put("/api/settings/user", { data: { onboardingCompleted: true } });
        const context = await browser.newContext({ baseURL, extraHTTPHeaders: clientHeaders(), storageState: await api.storageState() });
        try {
            const page = await context.newPage();
            await page.goto("/settings/summary");
            await page.getByRole("button", { name: "Add Custom Prompt" }).click();
            await page.getByTestId("custom-summary-prompt-name").fill("Settings UI prompt");
            await page.getByTestId("custom-summary-prompt-text").fill("Summarize this transcript: {transcription}");
            await page.getByRole("button", { name: "Create", exact: true }).click();
            await expect(page.getByText("Settings UI prompt")).toBeVisible();
            await expect
                .poll(async () => {
                    const userSettings = await (await api.get("/api/settings/user")).json();
                    const prompts: { name: string }[] = userSettings.summaryPrompt?.customPrompts ?? [];
                    return prompts.some((prompt) => prompt.name === "Settings UI prompt");
                })
                .toBe(true);
        } finally {
            await context.close();
        }
    } finally {
        await api.dispose();
    }
});
