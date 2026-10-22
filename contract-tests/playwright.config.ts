import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";
import { storageStatePath } from "./helpers/api";

// Black-box contract suite. It talks to a running server over HTTP only, so the
// same tests run against any implementation. The target is started by the caller
// (see run.sh); this config never starts a server itself.
const baseURL = process.env.OAH_BASE_URL ?? "http://localhost:3210";

export default defineConfig({
    testDir: "./tests",
    globalSetup: "./helpers/global-setup.ts",
    workers: 1,
    fullyParallel: false,
    retries: 0,
    timeout: 60_000,
    expect: { timeout: 10_000 },
    reporter: [["list"]],
    outputDir: resolve(__dirname, "../.dev-artifacts/contract-results"),
    use: {
        baseURL,
        // Own rate-limit bucket for the main account's requests (see clientHeaders).
        extraHTTPHeaders: {
            origin: baseURL,
            "x-forwarded-for": `10.0.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`,
        },
        // The interface tests assert English text and English date formats. Pinning the locale
        // keeps them independent of the machine the suite runs on.
        locale: "en-US",
        storageState: storageStatePath,
        // Keep a trace for a failed run, so CI failures can be inspected afterwards.
        trace: "retain-on-failure",
    },
    // The long-recording pipeline runs on its own server, so its tests live in their own
    // project: the default run keeps them out, and pipeline mode runs only them.
    projects: [
        {
            name: "contract",
            testIgnore: ["pipeline/**", "single-account/**"],
        },
        {
            name: "pipeline",
            testMatch: ["pipeline/**/*.spec.ts"],
            // Speech detection, chunk transcription and the save step take longer than the
            // suite-wide limit, and a slow machine adds to every poll.
            timeout: 180_000,
        },
        {
            // Runs against a server in single-account mode, so it starts with no session.
            name: "single-account",
            testMatch: ["single-account/**/*.spec.ts"],
            use: { storageState: { cookies: [], origins: [] } },
        },
    ],
});
