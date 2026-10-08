import { expect, test } from "@playwright/test";

// F24 under a production build: the dev-only page and route are not served,
// even to a signed-in user. The development behaviour is covered by e2e/dev, which
// runs under `next dev` (pnpm e2e:dev).
test("the demo workstation is a 404 in a production build", async ({
    page,
}) => {
    const response = await page.goto("/dev/demo-dashboard");
    expect(response?.status()).toBe(404);
});

test("the Plaud introspection route is a 404 in a production build", async ({
    request,
}) => {
    const response = await request.get("/api/dev/plaud/info");
    expect(response.status()).toBe(404);
});
