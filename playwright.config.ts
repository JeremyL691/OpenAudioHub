import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

// Load the generated E2E env (scripts/dev/e2e-prepare.ts) into process.env so the
// webServer processes, globalSetup, and specs share one configuration. Values are
// never logged.
const E2E_ENV_FILE = resolve(__dirname, "e2e/.env.e2e");
if (existsSync(E2E_ENV_FILE)) {
    for (const line of readFileSync(E2E_ENV_FILE, "utf8").split("\n")) {
        const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
        if (match) process.env[match[1]] = match[2];
    }
}

const appEnv = Object.fromEntries(
    Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
    ),
);

export default defineConfig({
    testDir: "./e2e",
    testMatch: "**/*.spec.ts",
    // Dev-only specs run under `next dev` from playwright.dev.config.ts, never against
    // the production server.
    testIgnore: "dev/**",
    globalSetup: "./e2e/global-setup.ts",
    workers: 1,
    fullyParallel: false,
    retries: 0,
    timeout: 60_000,
    expect: { timeout: 10_000 },
    reporter: [
        ["list"],
        ["html", { open: "never", outputFolder: "playwright-report" }],
    ],
    outputDir: "test-results",
    use: {
        baseURL: "http://localhost:3210",
        storageState: resolve(__dirname, "e2e/.auth/user.json"),
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
    },
    projects: [
        {
            name: "chromium-desktop",
            use: {
                ...devices["Desktop Chrome"],
                viewport: { width: 1280, height: 800 },
            },
        },
    ],
    webServer: [
        {
            command: "bun scripts/dev/fake-ai-server.ts",
            url: "http://127.0.0.1:3299/v1/models",
            reuseExistingServer: false,
            env: appEnv,
            timeout: 30_000,
        },
        {
            command:
                process.env.E2E_SERVER_COMMAND ??
                "pnpm build && pnpm start -p 3210",
            url: "http://localhost:3210/api/health",
            reuseExistingServer: false,
            env: appEnv,
            timeout: 900_000,
        },
    ],
});
