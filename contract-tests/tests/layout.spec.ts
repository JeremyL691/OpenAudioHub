import { expect, test } from "@playwright/test";
import { baseURL, clientHeaders, newUserContext, uploadRecording } from "../helpers/api";

const VIEWPORTS = [320, 768, 1024, 1440];
const HEIGHT = 900;

async function newLayoutUser() {
    for (let attempt = 1; ; attempt++) {
        try {
            return await newUserContext("layout");
        } catch (error) {
            if (attempt >= 8) throw error;
            await new Promise((resolve) => setTimeout(resolve, 15_000));
        }
    }
}

test("dashboard layout keeps its column geometry and the 256 px sidebar across widths and themes", async ({ browser }) => {
    const api = await newLayoutUser();
    try {
        await api.put("/api/settings/user", { data: { onboardingCompleted: true } });
        await uploadRecording(api);

        const context = await browser.newContext({
            baseURL,
            extraHTTPHeaders: clientHeaders(),
            storageState: await api.storageState(),
        });
        try {
            const page = await context.newPage();
            for (const colorScheme of ["light", "dark"] as const) {
                await page.emulateMedia({ colorScheme });
                for (const width of VIEWPORTS) {
                    await page.setViewportSize({ width, height: HEIGHT });
                    await page.goto("/dashboard");

                    const glance = page.getByRole("region", { name: "At a glance" });
                    const latest = page.getByRole("region", { name: "Latest recording" });
                    const recent = page.getByRole("region", { name: "Recent recordings" });
                    await expect(glance).toBeVisible();
                    await expect(latest).toBeVisible();
                    await expect(recent).toBeVisible();

                    const geometry = await page.evaluate(() => {
                        const box = (selector: string) => {
                            const rect = document.querySelector(selector)?.getBoundingClientRect();
                            return rect ? { x: rect.x, y: rect.y, width: rect.width, bottom: rect.bottom } : null;
                        };
                        return {
                            viewportWidth: document.documentElement.clientWidth,
                            documentWidth: document.documentElement.scrollWidth,
                            glance: box('[aria-label="At a glance"]'),
                            latest: box('[aria-labelledby="latest-recording-heading"]'),
                            recent: box('[aria-label="Recent recordings"]'),
                            sidebar: (() => {
                                const nav = document.querySelector('[data-testid="app-sidebar"]');
                                const rect = nav?.parentElement?.getBoundingClientRect();
                                return rect ? { x: rect.x, y: rect.y, width: rect.width, bottom: rect.bottom } : null;
                            })(),
                            settings: box('[data-testid="nav-settings"]'),
                            docs: box('[data-testid="nav-docs"]'),
                            footer: box('[data-testid="sidebar-footer"]'),
                        };
                    });

                    expect(geometry.documentWidth, `${colorScheme} at ${width}px`).toBeLessThanOrEqual(geometry.viewportWidth);
                    expect(geometry.glance).not.toBeNull();
                    expect(geometry.latest).not.toBeNull();
                    expect(geometry.recent).not.toBeNull();
                    expect(Math.abs(geometry.glance!.width - geometry.latest!.width)).toBeLessThanOrEqual(1);
                    expect(Math.abs(geometry.latest!.width - geometry.recent!.width)).toBeLessThanOrEqual(1);
                    expect(geometry.latest!.y).toBeGreaterThanOrEqual(geometry.glance!.bottom);
                    expect(geometry.recent!.y).toBeGreaterThanOrEqual(geometry.latest!.bottom);

                    if (width >= 768) {
                        expect(geometry.sidebar).not.toBeNull();
                        expect(geometry.sidebar!.width).toBe(256);
                        expect(geometry.settings).not.toBeNull();
                        expect(geometry.docs).not.toBeNull();
                        expect(geometry.footer).not.toBeNull();
                        expect(geometry.settings!.y).toBeGreaterThan(HEIGHT * 0.55);
                        expect(geometry.docs!.y).toBeGreaterThan(geometry.settings!.bottom);
                        expect(geometry.footer!.y).toBeGreaterThan(geometry.docs!.bottom);
                        expect(geometry.footer!.bottom).toBeLessThanOrEqual(HEIGHT);
                    } else {
                        expect(geometry.sidebar).toBeNull();
                    }
                }
            }
        } finally {
            await context.close();
        }
    } finally {
        await api.dispose();
    }
});
