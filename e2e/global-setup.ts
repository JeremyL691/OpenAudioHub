import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

// Seeds the E2E account once per run. Playwright starts the webServer entries
// before global setup, so the seed can sign up and sign in through the running app.
export default function globalSetup(): void {
    execFileSync("bun", ["scripts/dev/seed-e2e.ts"], {
        cwd: resolve(__dirname, ".."),
        env: process.env,
        stdio: "inherit",
    });
}
