import { expect, test } from "@playwright/test";

// The docs site is public, so these run without a signed-in session.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe("docs site", () => {
    test("the docs home shows the mark and the title", async ({
        page,
        request,
    }) => {
        await page.goto("/docs");
        await expect(
            page.getByRole("link", { name: /OpenAudioHub Docs/ }).first(),
        ).toBeVisible();
        // The nav mark is a fixed 20 px image; a zero-size box means it did not render.
        // The docs shell renders the title twice, so pick the copy that is on screen.
        const mark = page
            .locator('a[href="/docs"] img')
            .filter({ visible: true })
            .first();
        await expect(mark).toBeVisible();
        expect(await mark.boundingBox()).toMatchObject({
            width: 20,
            height: 20,
        });
        expect((await request.get("/brand/mark.svg")).ok()).toBeTruthy();
    });

    test("the docs cover image is served as a PNG", async ({ request }) => {
        const response = await request.get("/docs-og/index.png");
        expect(response.ok()).toBeTruthy();
        expect(response.headers()["content-type"]).toContain("image/png");
    });
});
