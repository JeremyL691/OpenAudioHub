import { expect, test } from "@playwright/test";

// Regression guard: "Back to app" on the docs must load the dashboard with the app
// sidebar visible. The link used to be a client-side route change, which left
// fumadocs' stylesheet loaded and hid the sidebar.
test("Back to app on the docs opens the dashboard with the sidebar", async ({
    page,
}) => {
    await page.goto("/docs");
    await page
        .getByRole("link", { name: "Back to app" })
        .filter({ visible: true })
        .click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByTestId("app-sidebar")).toBeVisible();
});
