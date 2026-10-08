import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { RECORDINGS } from "./characterization/helpers";

// Axe check for the Phase 5 pages (PLAN §6 P5 gate), in light and dark. Serious
// and critical violations fail the test; moderate and minor ones are not
// asserted here.
async function expectNoSeriousViolations(page: Page) {
    // The sync button dims while it is disabled (disabled:opacity-50), which is
    // a legitimate inactive state. Audit the settled page, not the busy one.
    const sync = page.getByTestId("sync-button");
    if ((await sync.count()) > 0) {
        await expect(sync).toBeEnabled();
    }
    // The summary button is disabled while a summary runs, for the same reason.
    const summary = page.getByTestId("summary-generate");
    if ((await summary.count()) > 0) {
        await expect(summary).toBeEnabled();
    }

    const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
    // One entry per blocking rule: its impact, then up to five nodes with their
    // selector and failure reason, so a failure names the element to fix.
    const blocking = results.violations
        .filter((v) => v.impact === "serious" || v.impact === "critical")
        .map((v) => {
            const nodes = v.nodes.slice(0, 5).map((node) => {
                const reason = (node.failureSummary ?? "")
                    .replace(/\s+/g, " ")
                    .slice(0, 160);
                const markup = (node.html ?? "")
                    .replace(/\s+/g, " ")
                    .slice(0, 160);
                return `${node.target.join(" ")} <${markup}> [${reason}]`;
            });
            return `${v.id} (${v.impact}, ${v.nodes.length} node(s)): ${nodes.join(" | ")}`;
        });
    expect(blocking).toEqual([]);
}

for (const scheme of ["light", "dark"] as const) {
    test.describe(`accessibility: signed in, ${scheme}`, () => {
        test.use({ colorScheme: scheme });

        test("overview", async ({ page }) => {
            await page.goto("/dashboard");
            await expect(
                page.getByRole("region", { name: "Totals" }),
            ).toBeVisible();
            await expectNoSeriousViolations(page);
        });

        test("library", async ({ page }) => {
            await page.goto("/recordings");
            await expect(page.getByTestId("recording-list")).toBeVisible();
            await expectNoSeriousViolations(page);
        });

        test("recording detail", async ({ page }) => {
            await page.goto("/recordings");
            await expect(page.getByTestId("recording-list")).toBeVisible();
            const id = await page
                .getByTestId("recording-row")
                .filter({ hasText: RECORDINGS.weekly })
                .getAttribute("data-id");
            await page.goto(`/recordings/${id}`);
            await expect(page.getByTestId("player")).toBeVisible();
            await expectNoSeriousViolations(page);
        });

        test("settings: providers", async ({ page }) => {
            await page.goto("/settings/providers");
            await expectNoSeriousViolations(page);
        });

        test("settings: notifications", async ({ page }) => {
            await page.goto("/settings/notifications");
            await expectNoSeriousViolations(page);
        });

        test("command palette", async ({ page }) => {
            await page.goto("/recordings");
            await expect(page.getByTestId("recording-list")).toBeVisible();
            await page.keyboard.press("ControlOrMeta+k");
            await expect(page.getByRole("dialog")).toBeVisible();
            await page.waitForTimeout(400);
            await expectNoSeriousViolations(page);
        });
    });

    test.describe(`accessibility: signed out, ${scheme}`, () => {
        test.use({
            colorScheme: scheme,
            storageState: { cookies: [], origins: [] },
        });

        test("landing", async ({ page }) => {
            await page.goto("/");
            await expectNoSeriousViolations(page);
        });

        test("login", async ({ page }) => {
            await page.goto("/login");
            await expectNoSeriousViolations(page);
        });

        test("docs", async ({ page }) => {
            await page.goto("/docs");
            await expectNoSeriousViolations(page);
        });
    });
}
