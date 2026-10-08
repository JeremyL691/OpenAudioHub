import { resolve } from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
    resolve: {
        alias: {
            "@": resolve(__dirname, "./src"),
        },
    },
    test: {
        environment: "node",
        exclude: [...configDefaults.exclude, ".next/**"],
    },
});
