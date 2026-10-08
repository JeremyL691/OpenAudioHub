import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Dev-mode E2E for the dev-only routes. Those routes return 404 under a
// production build, so this config runs `next dev` on the port the production suite
// uses (playwright.config.ts). Run the two suites one after the other, never together:
// both bind port 3210, and both write to .next.
const appEnv = Object.fromEntries(
    Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
    ),
);

export default defineConfig({
    ...base,
    testDir: "./e2e/dev",
    testIgnore: [],
    outputDir: ".dev-artifacts/e2e-dev",
    reporter: [["list"]],
    timeout: 180_000,
    webServer: [
        {
            command: "bun scripts/dev/fake-ai-server.ts",
            url: "http://127.0.0.1:3299/v1/models",
            reuseExistingServer: false,
            env: appEnv,
            timeout: 30_000,
        },
        {
            command: "pnpm exec next dev -p 3210",
            url: "http://localhost:3210/api/health",
            reuseExistingServer: false,
            env: { ...appEnv, NODE_ENV: "development" },
            timeout: 300_000,
        },
    ],
});
