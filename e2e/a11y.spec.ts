import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { RECORDINGS } from "./characterization/helpers";

// Axe check for the main pages, in light and dark. Serious
// and critical violations fail the test; moderate and minor ones are not
// asserted here.

// A control is disabled while it is busy and dims (disabled:opacity-50). When it
// is enabled again it fades back over `transition-all`, so wait for the fade to
// finish too: axe would otherwise sample a mid-fade colour.
async function settle(control: Locator) {
    await expect(control).toBeEnabled();
    await expect
        .poll(() => control.evaluate((el) => getComputedStyle(el).opacity))
        .toBe("1");
}

// `modal` is set for menus and dialogs. Radix hides the app shell with
// aria-hidden while one is open and traps focus inside it, so the shell's links
// are not reachable and aria-hidden-focus is a false positive there.
async function expectNoSeriousViolations(
    page: Page,
    { modal = false }: { modal?: boolean } = {},
) {
    // The sync and summary buttons are busy at times. Audit the settled page.
    const sync = page.getByTestId("sync-button");
    if ((await sync.count()) > 0) {
        await settle(sync);
    }
    const summary = page.getByTestId("summary-generate");
    if ((await summary.count()) > 0) {
        await settle(summary);
    }

    const builder = new AxeBuilder({ page }).withTags([
        "wcag2a",
        "wcag2aa",
        "wcag21a",
        "wcag21aa",
    ]);
    if (modal) {
        builder.disableRules(["aria-hidden-focus"]);
    }
    const results = await builder.analyze();
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

        for (const section of [
            "transcription",
            "summary",
            "plaud-account",
            "sync",
            "playback",
            "display",
            "storage",
            "export",
            "api-keys",
            "webhooks",
        ]) {
            test(`settings: ${section}`, async ({ page }) => {
                await page.goto(`/settings/${section}`);
                await expectNoSeriousViolations(page);
            });
        }

        test("user menu", async ({ page }) => {
            await page.goto("/recordings");
            await expect(page.getByTestId("recording-list")).toBeVisible();
            await page.getByTestId("user-menu").click();
            await expect(page.getByRole("menu")).toBeVisible();
            await expectNoSeriousViolations(page, { modal: true });
        });

        test("report a bug dialog", async ({ page }) => {
            await page.goto("/recordings");
            await expect(page.getByTestId("recording-list")).toBeVisible();
            // The entry is a button in the sidebar footer, not a menu item.
            await page
                .getByRole("button", { name: "Report a bug" })
                .first()
                .click();
            await expect(
                page.getByRole("dialog", { name: "Report a bug" }),
            ).toBeVisible();
            await expectNoSeriousViolations(page, { modal: true });
        });

        test("keyboard shortcuts dialog", async ({ page }) => {
            await page.goto("/recordings");
            await expect(page.getByTestId("recording-list")).toBeVisible();
            await page.keyboard.type("?");
            await expect(
                page.getByRole("dialog", { name: "Keyboard shortcuts" }),
            ).toBeVisible();
            await expectNoSeriousViolations(page);
        });

        test("delete confirmation", async ({ page }) => {
            await page.goto("/recordings");
            await expect(page.getByTestId("recording-list")).toBeVisible();
            const id = await page
                .getByTestId("recording-row")
                .filter({ hasText: RECORDINGS.weekly })
                .getAttribute("data-id");
            await page.goto(`/recordings/${id}`);
            await expect(page.getByTestId("player")).toBeVisible();
            await page
                .getByRole("button", { name: "Recording actions" })
                .click();
            await page
                .getByRole("menuitem", { name: "Delete recording" })
                .click();
            await expect(page.getByRole("dialog")).toBeVisible();
            // The actions menu fades out as the dialog opens; audit after it is gone.
            await expect(
                page.locator('[data-slot="dropdown-menu-content"]'),
            ).toHaveCount(0);
            await expectNoSeriousViolations(page, { modal: true });
            // Cancel: the audit must not delete anything.
            await page.getByRole("button", { name: "Cancel" }).click();
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

        test("not found", async ({ page }) => {
            await page.goto("/no-such-page-for-axe");
            await expectNoSeriousViolations(page);
        });
    });
}
