import { expect, request, test } from "@playwright/test";
import { baseURL, freshCredentials } from "../helpers/api";

// Exercise the complete browser login path with a fresh account. The HTTP auth
// contracts alone cannot catch a cookie that is set but not retained by the UI.
test("browser login keeps the session and Plaud browser sign-in opens its handoff page", async ({ browser }) => {
    const who = freshCredentials("browser-login");
    const ip = `10.21.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;
    const api = await request.newContext({
        baseURL,
        extraHTTPHeaders: { origin: baseURL, "x-forwarded-for": ip },
    });
    const signup = await api.post("/api/auth/sign-up/email", {
        data: { name: who.name, email: who.email, password: who.password },
    });
    expect(signup.status(), "create account for browser login").toBe(200);
    const onboarded = await api.put("/api/settings/user", { data: { onboardingCompleted: true } });
    expect(onboarded.status(), "complete first-run onboarding for browser flow").toBe(200);
    await api.dispose();

    const context = await browser.newContext({
        baseURL,
        extraHTTPHeaders: { origin: baseURL, "x-forwarded-for": ip },
        storageState: { cookies: [], origins: [] },
    });
    const page = await context.newPage();
    await page.goto("/login");
    await page.getByLabel("Email").fill(who.email);
    await page.getByLabel("Password").fill(who.password);
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page).toHaveURL(/\/dashboard(?:$|[?#])/);
    await expect(page.getByTestId("app-sidebar")).toBeVisible();
    const session = await page.request.get("/api/auth/get-session");
    expect(session.status()).toBe(200);
    expect((await session.json()).user.email).toBe(who.email);

    await page.goto("/settings/plaud-account");
    await page.getByRole("tab", { name: "Sign in with Plaud" }).click();
    const popupPromise = page.waitForEvent("popup");
    await page.getByRole("button", { name: "Open Plaud sign-in" }).click();
    const popup = await popupPromise;
    await expect(popup).toHaveURL(/\/connect\/plaud\?code=[A-Za-z0-9_-]{43}$/);
    await popup.close();
    await context.close();
});
