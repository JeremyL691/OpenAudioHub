import { expect, type Page, test } from "@playwright/test";
import { RECORDINGS, signIn } from "./characterization/helpers";

// No page scrolls sideways from a 320 px phone to a 1440 px desktop (PLAN §6 P7
// T7.2). A page overflows when its content is wider than the viewport.

const WIDTHS = [320, 360, 768, 1024, 1440];

async function overflowPx(page: Page): Promise<number> {
    return page.evaluate(
        () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
    );
}

// Looks up the seeded long recording's full-page path, from the library.
async function longRecordingPath(page: Page): Promise<string> {
    await page.goto("/recordings");
    await expect(page.getByTestId("recording-list")).toBeVisible();
    const id = await page
        .getByTestId("recording-row")
        .filter({ hasText: RECORDINGS.long })
        .getAttribute("data-id");
    return `/recordings/${id}`;
}

for (const width of WIDTHS) {
    test.describe(`no horizontal overflow at ${width}px`, () => {
        test.use({ viewport: { width, height: 800 } });

        test("signed-in pages fit", async ({ page }) => {
            await signIn(page);
            const paths = [
                "/dashboard",
                "/recordings",
                await longRecordingPath(page),
                "/settings/providers",
            ];
            for (const path of paths) {
                await page.goto(path);
                await expect(page.locator("main, body").first()).toBeVisible();
                const overflow = await overflowPx(page);
                expect(overflow, `${path} at ${width}px`).toBeLessThanOrEqual(
                    0,
                );
            }
        });

        test("signed-out pages fit", async ({ page }) => {
            await page.context().clearCookies();
            for (const path of ["/", "/login", "/docs"]) {
                await page.goto(path);
                await expect(page.locator("body")).toBeVisible();
                const overflow = await overflowPx(page);
                expect(overflow, `${path} at ${width}px`).toBeLessThanOrEqual(
                    0,
                );
            }
        });
    });
}
