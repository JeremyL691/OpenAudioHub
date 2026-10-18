import { defineConfig } from "vitest/config";

// Unit tests only. The Playwright suite under tests/e2e runs with @playwright/test.
export default defineConfig({
    test: {
        include: ["tests/unit/**/*.test.ts"],
        environment: "node",
    },
});
