import { defineConfig } from "@playwright/test";

// Loads the test build of the extension in Chromium and runs against the server that
// global-setup.ts starts on a test port. The browser runs headed because Chromium only
// side-loads extensions in headed mode. CI wraps the run in xvfb.
export default defineConfig({
    testDir: ".",
    testMatch: "**/*.spec.ts",
    workers: 1,
    fullyParallel: false,
    timeout: 120_000,
    expect: { timeout: 20_000 },
    reporter: [["list"]],
    globalSetup: "./global-setup.ts",
    globalTeardown: "./global-teardown.ts",
    outputDir: "../../../.dev-artifacts/extension-e2e-results",
    use: {
        headless: false,
        channel: "chromium",
        viewport: { width: 1100, height: 800 },
    },
});
