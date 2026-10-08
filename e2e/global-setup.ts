import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { type FullConfig, request } from "@playwright/test";

export const STORAGE_STATE = resolve(__dirname, ".auth/user.json");

// Seeds the E2E account once per run. Playwright starts the webServer entries
// before global setup, so the seed can sign up and sign in through the running app.
// Then it signs in once more and saves the session, which the tests reuse.
export default async function globalSetup(_config: FullConfig): Promise<void> {
    execFileSync("bun", ["scripts/dev/seed-e2e.ts"], {
        cwd: resolve(__dirname, ".."),
        env: process.env,
        stdio: "inherit",
    });

    const appUrl = process.env.APP_URL ?? "http://localhost:3210";
    const api = await request.newContext({
        baseURL: appUrl,
        extraHTTPHeaders: { origin: appUrl },
    });
    const response = await api.post("/api/auth/sign-in/email", {
        data: {
            email: process.env.E2E_EMAIL,
            password: process.env.E2E_PASSWORD,
        },
    });
    if (!response.ok()) {
        throw new Error(
            `storage-state sign-in failed with HTTP ${response.status()}`,
        );
    }
    mkdirSync(dirname(STORAGE_STATE), { recursive: true });
    await api.storageState({ path: STORAGE_STATE });
    await api.dispose();
}
