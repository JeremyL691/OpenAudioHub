import { describe, expect, it } from "vitest";
import { childEnvironment } from "../src/main/services.js";

describe("childEnvironment", () => {
    it("contains only the allow-listed keys and the explicit extras", () => {
        const env = childEnvironment("/bundle/bin", {
            DATABASE_URL: "postgres://example.test/db",
        });

        expect(Object.keys(env).sort()).toEqual(
            [
                "DATABASE_URL",
                "LANG",
                "NEXT_TELEMETRY_DISABLED",
                "NODE_ENV",
                "PATH",
                "TZ",
            ].sort(),
        );
        expect(env.PATH).toBe("/bundle/bin:/usr/bin:/bin");
        expect(env.TZ).toBe("UTC");
    });

    it("does not inherit variables from the parent process", () => {
        process.env.OAH_TEST_PARENT_ONLY = "leak";
        try {
            expect(childEnvironment("/bundle/bin", {})).not.toHaveProperty(
                "OAH_TEST_PARENT_ONLY",
            );
        } finally {
            delete process.env.OAH_TEST_PARENT_ONLY;
        }
    });
});
