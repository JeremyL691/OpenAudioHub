import { type APIRequestContext, type APIResponse, expect, request, test } from "@playwright/test";
import {
    anonymousContext,
    baseURL,
    clientHeaders,
    configureAccount,
    freshCredentials,
} from "../../helpers/api";

// Single-account mode is the server default: one local account, no sign-up, and the
// app opens without a sign-in. Runs against a server started by `run.sh single`.

/** A request context that does not follow redirects, so the redirect answer can be read. */
async function noRedirects(base = baseURL): Promise<APIRequestContext> {
    return request.newContext({
        baseURL: base,
        extraHTTPHeaders: clientHeaders(),
        maxRedirects: 0,
        storageState: { cookies: [], origins: [] },
    });
}

function setCookies(res: APIResponse): string[] {
    return res
        .headersArray()
        .filter((h) => h.name.toLowerCase() === "set-cookie")
        .map((h) => h.value);
}

test("the root redirects to the dashboard and sets the session cookie", async () => {
    const api = await noRedirects();
    const res = await api.get("/");
    expect(res.status()).toBe(307);
    expect(res.headers()["location"]).toBe("/dashboard");
    expect(setCookies(res).some((c) => c.startsWith("oah_session="))).toBeTruthy();
    await api.dispose();
});

test("the auth pages redirect to the dashboard", async () => {
    const api = await noRedirects();
    for (const path of ["/login", "/register", "/forgot-password"]) {
        const res = await api.get(path);
        expect(res.status(), path).toBe(307);
        expect(res.headers()["location"], path).toBe("/dashboard");
    }
    await api.dispose();
});

test("an app page keeps its path and query through the redirect", async () => {
    const api = await noRedirects();
    const res = await api.get("/recordings?x=1");
    expect(res.status()).toBe(307);
    expect(res.headers()["location"]).toBe("/recordings?x=1");
    await api.dispose();
});

test("another host name gets no session and is sent to the app address", async () => {
    const other = new URL(baseURL);
    other.hostname = "127.0.0.1";
    const api = await noRedirects(other.origin);
    const res = await api.get("/");
    expect(res.status()).toBe(307);
    expect(res.headers()["location"]).toBe(`${baseURL}/dashboard`);
    expect(setCookies(res)).toEqual([]);
    await api.dispose();
});

test("the auth config reports single-account mode with registration off", async () => {
    const api = await anonymousContext();
    const res = await api.get("/api/auth/config");
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({ singleAccount: true, registrationEnabled: false });
    await api.dispose();
});

test("sign-up is refused because registration is disabled", async () => {
    const api = await anonymousContext();
    const res = await api.post("/api/auth/sign-up/email", { data: freshCredentials("single") });
    expect(res.status()).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe("REGISTRATION_DISABLED");
    await api.dispose();
});

test("API calls without a session answer 401", async () => {
    const api = await anonymousContext();
    const res = await api.get("/api/recordings");
    expect(res.status()).toBe(401);
    await api.dispose();
});

test("two fresh visitors are the same account", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
        const api = await request.newContext({ baseURL, extraHTTPHeaders: clientHeaders() });
        expect((await api.get("/")).ok()).toBeTruthy();
        const session = await api.get("/api/auth/get-session");
        expect(session.status()).toBe(200);
        ids.push(((await session.json()) as { user: { id: string } }).user.id);
        await api.dispose();
    }
    expect(ids[1]).toBe(ids[0]);
});

test("a fresh browser opens the app as the local account", async ({ browser }) => {
    const api = await request.newContext({ baseURL, extraHTTPHeaders: clientHeaders() });
    expect((await api.get("/")).ok()).toBeTruthy();
    await configureAccount(api);
    const ctx = await browser.newContext({
        baseURL,
        locale: "en-US",
        extraHTTPHeaders: clientHeaders(),
        storageState: await api.storageState(),
    });
    try {
        const page = await ctx.newPage();
        await page.goto("/");
        await expect(page).toHaveURL(/\/dashboard(?:$|[?#])/);
        await expect(page.getByTestId("app-sidebar")).toBeVisible();

        await page.getByTestId("user-menu").click();
        const menu = page.getByRole("menu");
        await expect(menu.getByText("Local account")).toBeVisible();
        await expect(menu.getByRole("menuitem", { name: "Log out" })).toHaveCount(0);
    } finally {
        await ctx.close();
        await api.dispose();
    }
});
