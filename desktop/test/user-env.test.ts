import { describe, expect, it } from "vitest";
import {
    MANAGED_KEYS,
    parseUserEnv,
    USER_ENV_ALLOWLIST,
} from "../src/main/user-env.js";

describe("parseUserEnv", () => {
    it("accepts allow-listed keys, comments, quotes and blank lines", () => {
        const result = parseUserEnv(
            [
                "# SMTP for notifications",
                "SMTP_HOST=smtp.example.test",
                'SMTP_PORT="587"',
                "",
                "WHISPER_MAX_BYTES='26214400'",
            ].join("\n"),
        );

        expect(result.values).toEqual({
            SMTP_HOST: "smtp.example.test",
            SMTP_PORT: "587",
            WHISPER_MAX_BYTES: "26214400",
        });
        expect(result.unknownKeys).toEqual([]);
        expect(result.badLines).toEqual([]);
    });

    it("refuses keys the app manages and reports them by name only", () => {
        const result = parseUserEnv(
            "DATABASE_URL=postgres://user:secret-value@host/db\nBETTER_AUTH_SECRET=hidden\n",
        );

        expect(result.values).toEqual({});
        expect(result.managedKeys).toEqual([
            "DATABASE_URL",
            "BETTER_AUTH_SECRET",
        ]);
        expect(JSON.stringify(result)).not.toContain("secret-value");
        expect(JSON.stringify(result)).not.toContain("hidden");
    });

    it("reports unknown keys and bad lines with line numbers", () => {
        const result = parseUserEnv(
            "SOMETHING_ELSE=1\nnot a setting\nS3_BUCKET=bucket-a\n",
        );

        expect(result.unknownKeys).toEqual(["SOMETHING_ELSE"]);
        expect(result.badLines).toEqual([2]);
        expect(result.values).toEqual({ S3_BUCKET: "bucket-a" });
    });

    it("keeps the allow-list and the managed list disjoint", () => {
        for (const key of USER_ENV_ALLOWLIST) {
            expect(MANAGED_KEYS.has(key)).toBe(false);
        }
    });
});
