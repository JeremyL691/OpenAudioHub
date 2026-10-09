import { expect, test } from "@playwright/test";
import { RECORDINGS, signIn } from "../characterization/helpers";

// The transcript and summary cards collapse to their header. The choice is saved in
// the browser, so a collapsed card stays collapsed after a reload.
test("transcript and summary cards collapse and keep their state after a reload", async ({
    page,
}) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await signIn(page);
    const id = await page
        .getByTestId("recording-row")
        .filter({ hasText: RECORDINGS.long })
        .getAttribute("data-id");
    await page.goto(`/recordings/${id}`);
    await expect(page.getByTestId("transcript-timeline")).toBeVisible();

    await page.getByRole("button", { name: "Collapse transcription" }).click();
    await expect(
        page.getByRole("button", { name: "Expand transcription" }),
    ).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("transcript-timeline")).toBeHidden();

    await page.getByRole("button", { name: "Collapse summary" }).click();
    await expect(
        page.getByRole("button", { name: "Expand summary" }),
    ).toHaveAttribute("aria-expanded", "false");

    await page.reload();
    await expect(
        page.getByRole("button", { name: "Expand transcription" }),
    ).toBeVisible();
    await expect(page.getByTestId("transcript-timeline")).toBeHidden();
    await expect(
        page.getByRole("button", { name: "Expand summary" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Expand transcription" }).click();
    await expect(page.getByTestId("transcript-timeline")).toBeVisible();
});
