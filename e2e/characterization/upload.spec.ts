import path from "node:path";
import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

const SAMPLE_AUDIO = path.resolve(
    __dirname,
    "../../src/tests/fixtures/sample.mp3",
);

test.describe("upload", () => {
    test("uploads an audio file into the library", async ({ page }) => {
        await signIn(page);
        const rows = page.getByTestId("recording-row");
        const before = await rows.count();

        const chooser = page.waitForEvent("filechooser");
        await page.getByTestId("upload-button").click();
        await (await chooser).setFiles(SAMPLE_AUDIO);

        await expect(rows).toHaveCount(before + 1, { timeout: 60_000 });
    });
});
