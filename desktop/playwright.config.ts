import { defineConfig } from "@playwright/test";

// The `_electron` suite (PLAN T16.3). It needs a test build: see e2e/electron.spec.ts.
export default defineConfig({
    testDir: "e2e",
    timeout: 900_000,
    workers: 1,
    fullyParallel: false,
    retries: 0,
    reporter: [["list"]],
    outputDir: "../.dev-artifacts/desktop-e2e",
});
