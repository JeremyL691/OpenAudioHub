import { expect, test } from "@playwright/test";

// F24 in development: the demo workstation and the Plaud introspection route.
// Runs under `next dev` (playwright.dev.config.ts, pnpm e2e:dev). The production build
// returns 404 for both (e2e/regressions/dev-routes-production.spec.ts).
// The first request in dev mode compiles the route, so the page loads get a longer timeout.
const COMPILE_TIMEOUT = 180_000;

test.describe("dev-only routes in development (F24)", () => {
    test("the demo workstation renders for a signed-in user", async ({
        page,
    }) => {
        const response = await page.goto("/dev/demo-dashboard", {
            timeout: COMPILE_TIMEOUT,
        });
        expect(response?.status()).toBe(200);
        await expect(
            page.getByText("Q4 board meeting.m4a").first(),
        ).toBeVisible({ timeout: COMPILE_TIMEOUT });
    });

    test("the demo workstation sends an anonymous visitor to sign-in", async ({
        browser,
    }) => {
        const context = await browser.newContext({
            storageState: { cookies: [], origins: [] },
        });
        const page = await context.newPage();
        await page.goto("/dev/demo-dashboard", { timeout: COMPILE_TIMEOUT });
        await expect(page).toHaveURL(/\/login/, { timeout: COMPILE_TIMEOUT });
        await context.close();
    });

    test("the Plaud introspection route reports no connection for the seeded account", async ({
        request,
    }) => {
        const response = await request.get("/api/dev/plaud/info", {
            timeout: COMPILE_TIMEOUT,
        });
        expect(response.status()).toBe(200);
        expect(await response.json()).toEqual({ connected: false });
    });

    test("the Plaud introspection route rejects anonymous callers", async ({
        playwright,
        baseURL,
    }) => {
        // The config's storage state (a signed-in session) applies unless it is cleared here.
        const anonymous = await playwright.request.newContext({
            baseURL,
            storageState: { cookies: [], origins: [] },
        });
        const response = await anonymous.get("/api/dev/plaud/info", {
            timeout: COMPILE_TIMEOUT,
        });
        expect(response.status()).toBe(401);
        await anonymous.dispose();
    });
});
