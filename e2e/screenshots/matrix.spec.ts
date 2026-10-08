import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { RECORDINGS, signIn } from "../characterization/helpers";

// Full-page screenshot matrix: route x width x colour scheme.
// Output lands in .dev-artifacts/screenshots/<SHOT_SET>/ (git-ignored). SHOT_SET
// defaults to "before"; the redesign phases write "after" with the same matrix.
const SHOT_SET = process.env.SHOT_SET ?? "before";
const OUT_DIR = path.resolve(
    __dirname,
    "../../.dev-artifacts/screenshots",
    SHOT_SET,
);
const WIDTHS = [375, 768, 1280, 1440] as const;
const SCHEMES = ["light", "dark"] as const;

type Target = {
    slug: string;
    authed: boolean;
    open: (page: Page) => Promise<void>;
};

const TARGETS: Target[] = [
    {
        slug: "landing",
        authed: false,
        open: async (page) => {
            await page.goto("/");
        },
    },
    {
        slug: "login",
        authed: false,
        open: async (page) => {
            await page.goto("/login");
        },
    },
    {
        slug: "overview",
        authed: true,
        open: async (page) => {
            await page.goto("/dashboard");
            await expect(
                page.getByRole("region", { name: "Totals" }),
            ).toBeVisible();
        },
    },
    {
        slug: "library",
        authed: true,
        open: async (page) => {
            await page.goto("/recordings");
            await expect(page.getByTestId("recording-list")).toBeVisible();
        },
    },
    {
        slug: "recording-detail",
        authed: true,
        open: async (page) => {
            await page.goto("/recordings");
            await expect(page.getByTestId("recording-list")).toBeVisible();
            const id = await page
                .getByTestId("recording-row")
                .filter({ hasText: RECORDINGS.weekly })
                .getAttribute("data-id");
            await page.goto(`/recordings/${id}`);
        },
    },
    {
        slug: "settings",
        authed: true,
        open: async (page) => {
            await page.goto("/settings");
        },
    },
    {
        slug: "docs",
        authed: false,
        open: async (page) => {
            await page.goto("/docs");
        },
    },
];

mkdirSync(OUT_DIR, { recursive: true });

function defineMatrix(target: Target) {
    for (const width of WIDTHS) {
        for (const scheme of SCHEMES) {
            test(`${target.slug} at ${width}px in ${scheme} mode`, async ({
                page,
            }) => {
                await page.setViewportSize({ width, height: 900 });
                await page.emulateMedia({ colorScheme: scheme });
                if (target.authed) await signIn(page);
                await target.open(page);
                await page.waitForLoadState("networkidle");
                await page.screenshot({
                    path: path.join(
                        OUT_DIR,
                        `${target.slug}-${width}-${scheme}.png`,
                    ),
                    fullPage: true,
                });
            });
        }
    }
}

test.describe("screenshot matrix (signed in)", () => {
    for (const target of TARGETS.filter((t) => t.authed)) {
        test.describe(target.slug, () => defineMatrix(target));
    }
});

test.describe("screenshot matrix (signed out)", () => {
    test.use({ storageState: { cookies: [], origins: [] } });
    for (const target of TARGETS.filter((t) => !t.authed)) {
        test.describe(target.slug, () => defineMatrix(target));
    }
});
