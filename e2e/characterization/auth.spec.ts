import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

// These tests drive the login form themselves, so they start without the stored session.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe("auth", () => {
    test("signs in and then signs out from the account menu", async ({
        page,
    }) => {
        await signIn(page);

        await page.getByTestId("user-menu").click();
        await page.getByRole("menuitem", { name: "Log out" }).click();
        await page.waitForURL((url) => !url.pathname.startsWith("/dashboard"));

        await page.goto("/dashboard");
        await expect(page).toHaveURL(/\/login/);
    });

    test("rejects a wrong password without leaving the login page", async ({
        page,
    }) => {
        await page.goto("/login");
        await page.getByLabel("Email").fill(process.env.E2E_EMAIL ?? "");
        await page.getByLabel("Password").fill("wrong-password-value");
        await page.getByRole("button", { name: /sign in|log ?in/i }).click();

        await expect(page).toHaveURL(/\/login/);
    });
});
