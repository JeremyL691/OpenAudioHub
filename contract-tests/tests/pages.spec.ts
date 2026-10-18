import { expect, test } from "@playwright/test";
import { anonymousContext, baseURL, configureAccount } from "../helpers/api";

// Docs pages as they appear in the docs site (spec: pages.md, "Docs pages").
const DOCS_PAGES: [string, string][] = [
    ["/docs", "OpenAudioHub Docs"],
    ["/docs/guides/using-the-library", "Using the library"],
    ["/docs/guides/connect-plaud-account", "Connect your Plaud account"],
    ["/docs/guides/ai-providers", "AI providers"],
    ["/docs/guides/notifications", "Notifications"],
    ["/docs/guides/automation-and-webhooks", "Automation API and webhooks"],
    ["/docs/guides/backup-and-restore", "Backup and restore"],
    ["/docs/self-hosting", "Self-hosting"],
    ["/docs/self-hosting/install", "Install"],
    ["/docs/self-hosting/desktop", "Mac app (beta)"],
    ["/docs/self-hosting/environment-variables", "Environment variables"],
    ["/docs/self-hosting/storage-s3", "S3-compatible storage"],
    ["/docs/self-hosting/email-smtp", "Email (SMTP) setup"],
    ["/docs/reference/architecture", "Architecture"],
    ["/docs/reference/public-api", "Public API"],
    ["/docs/reference/encryption-at-rest", "Encryption at rest"],
    ["/docs/reference/security-model", "Security model"],
];

test("signed-in visitors are redirected from the landing page to the dashboard", async ({ request }) => {
    const res = await request.get("/", { maxRedirects: 0 });
    expect(res.status()).toBe(307);
    expect(new URL(res.headers().location, baseURL).pathname).toBe("/dashboard");
});

test("the landing page app is served to signed-out visitors at /", async () => {
    const api = await anonymousContext();
    const res = await api.get("/", { maxRedirects: 0 });
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/html");
    await api.dispose();
});

test("install page shows the latest and the version-pinned commands", async ({ page }) => {
    const res = await page.goto("/install");
    expect(res?.status()).toBe(200);
    await expect(page).toHaveTitle("Install OpenAudioHub | Self-host in one command · OpenAudioHub");
    await expect(page.getByRole("heading", { name: "Install OpenAudioHub" })).toBeVisible();
    await expect(page.getByText("releases/latest/download/install.sh")).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy install command" })).toBeEnabled();
    await expect(page.getByRole("link", { name: /View raw script/ })).toHaveAttribute(
        "href",
        "https://github.com/JeremyL691/OpenAudioHub/releases/latest/download/install.sh",
    );
    const health = (await (await page.request.get("/api/health")).json()) as { version: string };
    await expect(page.getByText(`releases/download/v${health.version}/install.sh`)).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy version-pinned install command" })).toBeEnabled();
});

test("unknown api paths answer with the JSON error shape", async () => {
    const api = await anonymousContext();
    const res = await api.get("/api/nope");
    expect(res.status()).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found", code: "NOT_FOUND" });
    await api.dispose();
});

test.describe("signed-out browser", () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test("landing page shows sign-in, register and docs links", async ({ page }) => {
        await page.goto("/");
        await expect(page.locator("h1")).toHaveText("Long recordings, intelligently transcribed.");
        await expect(page.getByRole("link", { name: "Sign in" }).first()).toHaveAttribute("href", "/login");
        await expect(page.getByRole("link", { name: "Create account" })).toHaveAttribute("href", "/register");
        await expect(page.getByRole("link", { name: "Read the docs" })).toHaveAttribute("href", "/docs");
        await expect(page.getByRole("heading", { level: 3 })).toHaveCount(6);
    });

    test("unknown page shows the not-found view with a home link", async ({ page }) => {
        const res = await page.goto("/does-not-exist-xyz");
        expect(res?.status()).toBe(404);
        await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
        await expect(page.getByRole("link", { name: "Back to home" })).toHaveAttribute("href", "/");
    });
});

test("health returns status and version JSON without a session", async () => {
    const api = await anonymousContext();
    const res = await api.get("/api/health");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("application/json");
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["status", "version"]);
    expect(body.status).toBe("ok");
    expect(String(body.version)).toMatch(/^\d+\.\d+\.\d+$/);
    await api.dispose();
});

for (const [url, title] of DOCS_PAGES) {
    // The app shell serves /docs/* and sets the title in the browser,
    // so the title is checked after the page renders.
    test(`docs page ${url} has its title`, async ({ page }) => {
        const res = await page.goto(url);
        expect(res?.status()).toBe(200);
        await expect(page).toHaveTitle(`${title} · OpenAudioHub`);
    });
}

test("unknown docs page shows the not-found view in the docs site", async ({ page }) => {
    // The app shell answers any /docs/* path with HTTP 200; the not-found view renders in the browser.
    await page.goto("/docs/guides/does-not-exist");
    await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
});

test("unknown page returns the not-found view for signed-out visitors", async () => {
    const api = await anonymousContext();
    const res = await api.get("/does-not-exist");
    expect(res.status()).toBe(404);
    expect(res.headers()["content-type"]).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("<h1");
    expect(html).toContain("Page not found");
    expect(html).toContain('name="robots" content="noindex"');
    expect(html).toContain("Back to home");
    await api.dispose();
});

test("not-found view for signed-in users links to recordings", async ({ request }) => {
    const res = await request.get("/does-not-exist");
    expect(res.status()).toBe(404);
    const html = await res.text();
    expect(html).toContain("Go to recordings");
    expect(html).toContain('href="/recordings"');
});

test("dev plaud diagnostics endpoint is not found in production", async ({ request }) => {
    const anon = await anonymousContext();
    const anonRes = await anon.get("/api/dev/plaud/info");
    expect(anonRes.status()).toBe(404);
    expect(await anonRes.json()).toEqual({ error: "Not found", code: "NOT_FOUND" });
    await anon.dispose();

    const res = await request.get("/api/dev/plaud/info");
    expect(res.status()).toBe(404);
});

test("dev demo dashboard is not found in production for signed-in users", async ({ request }) => {
    const res = await request.get("/dev/demo-dashboard", { maxRedirects: 0 });
    expect(res.status()).toBe(404);
});

test("suspended page sends signed-out visitors to login", async () => {
    const api = await anonymousContext();
    const res = await api.get("/suspended", { maxRedirects: 0 });
    expect(res.status()).toBe(307);
    expect(new URL(res.headers().location, baseURL).pathname).toBe("/login");
    await api.dispose();
});

test("suspended page sends active accounts to recordings", async ({ request }) => {
    const res = await request.get("/suspended", { maxRedirects: 0 });
    expect(res.status()).toBe(307);
    expect(new URL(res.headers().location, baseURL).pathname).toBe("/recordings");
});

test("suspended account sees the suspended page @skip", async () => {
    test.skip(true, "UNVERIFIED: needs an admin suspension; no public API sets it");
});

test("dashboard settings parameter forwards to a known section", async ({ request }) => {
    const res = await request.get("/dashboard?settings=providers", { maxRedirects: 0 });
    expect(res.status()).toBe(307);
    expect(new URL(res.headers().location, baseURL).pathname).toBe("/settings/providers");
});

test("dashboard with an unknown settings parameter shows the overview", async ({ request }) => {
    const res = await request.get("/dashboard?settings=not-a-section", { maxRedirects: 0 });
    expect(res.status()).toBe(200);
});

test("settings hash forwards to the section page in the browser", async ({ page, request }) => {
    await configureAccount(request);
    await page.goto("/settings#transcription");
    await page.waitForURL(/\/settings\/transcription$/);
});

test("icons and images are served with image types", async () => {
    const api = await anonymousContext();
    const cases: [string, string][] = [
        ["/favicon.ico", "image/x-icon"],
        ["/icon.svg", "image/svg+xml"],
        ["/apple-icon.png", "image/png"],
        ["/icon-192.png", "image/png"],
        ["/icon-512.png", "image/png"],
        ["/og.png", "image/png"],
    ];
    for (const [path, type] of cases) {
        const res = await api.get(path);
        expect(res.status(), path).toBe(200);
        expect(res.headers()["content-type"], path).toContain(type);
    }
    await api.dispose();
});

test("web app manifest describes the app", async () => {
    const api = await anonymousContext();
    const res = await api.get("/manifest.webmanifest");
    expect(res.status()).toBe(200);
    const manifest = (await res.json()) as Record<string, unknown>;
    expect(manifest.name).toBe("OpenAudioHub");
    expect(manifest.short_name).toBe("OpenAudioHub");
    expect(manifest.start_url).toBe("/");
    expect(manifest.display).toBe("standalone");
    expect(manifest.icons).toHaveLength(2);
    await api.dispose();
});

test("trailing slash on a page is accepted without redirect", async () => {
    const api = await anonymousContext();
    const res = await api.get("/install/", { maxRedirects: 0 });
    expect(res.status()).toBe(200);
    await api.dispose();
});

test("robots.txt blocks all crawlers and sitemap is empty", async () => {
    const api = await anonymousContext();
    const robots = await api.get("/robots.txt");
    expect(robots.status()).toBe(200);
    const text = await robots.text();
    expect(text).toContain("User-Agent: *");
    expect(text).toContain("Disallow: /");
    const sitemap = await api.get("/sitemap.xml");
    expect(sitemap.status()).toBe(200);
    expect(await sitemap.text()).toContain("<urlset");
    await api.dispose();
});

test("registration disabled hides the create account button @skip", async () => {
    test.skip(true, "UNVERIFIED: needs DISABLE_REGISTRATION=true on the target");
});

test("desktop mode always redirects the landing page to the dashboard @skip", async () => {
    test.skip(true, "UNVERIFIED: needs the desktop build");
});

test("pages and API answers send security headers", async () => {
    const api = await anonymousContext();
    for (const path of ["/login", "/api/health"]) {
        const h = (await api.get(path)).headers();
        expect(h["x-content-type-options"], path).toBe("nosniff");
        expect(h["x-frame-options"], path).toBe("DENY");
        expect(h["referrer-policy"], path).toBe("strict-origin-when-cross-origin");
        expect(h["content-security-policy"], path).toContain("script-src 'self'");
        expect(h["content-security-policy"], path).toContain("frame-ancestors 'none'");
    }
    await api.dispose();
});
