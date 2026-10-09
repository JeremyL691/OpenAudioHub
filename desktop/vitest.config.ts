import { configDefaults, defineConfig } from "vitest/config";

// Unit and integration tests only. The `_electron` specs run under Playwright (playwright.config.ts).
export default defineConfig({
    test: {
        exclude: [...configDefaults.exclude, "build/**", "e2e/**"],
    },
});
