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

    it("strips an inline comment that follows whitespace from an unquoted value", () => {
        const result = parseUserEnv(
            "SMTP_PASSWORD=hunter2 # work account\nSMTP_HOST=smtp.example.test\t# tab before comment\n",
        );

        expect(result.values).toEqual({
            SMTP_PASSWORD: "hunter2",
            SMTP_HOST: "smtp.example.test",
        });
        expect(result.badLines).toEqual([]);
    });

    it("keeps a # that is not preceded by whitespace in an unquoted value", () => {
        const result = parseUserEnv("SMTP_PASSWORD=abc#def\nSMTP_USER=#lead\n");

        expect(result.values).toEqual({
            SMTP_PASSWORD: "abc#def",
            SMTP_USER: "#lead",
        });
    });

    it("drops a trailing comment after a double-quoted value", () => {
        const result = parseUserEnv(
            'SMTP_PASSWORD="hunter 2" # work account\nSMTP_USER="a b"   \n',
        );

        expect(result.values).toEqual({
            SMTP_PASSWORD: "hunter 2",
            SMTP_USER: "a b",
        });
        expect(result.badLines).toEqual([]);
    });

    it("keeps # inside quotes and applies escapes in double quotes", () => {
        const result = parseUserEnv(
            'SMTP_PASSWORD="pa#ss \\"q\\" \\\\ \\t\\n end" # comment\n',
        );

        expect(result.values).toEqual({
            SMTP_PASSWORD: 'pa#ss "q" \\ \t\n end',
        });
    });

    it("keeps unknown escapes in double quotes as written", () => {
        const result = parseUserEnv('SMTP_PASSWORD="a\\db"\n');

        expect(result.values).toEqual({ SMTP_PASSWORD: "a\\db" });
    });

    it("reads single-quoted values literally, with no escapes", () => {
        const result = parseUserEnv(
            "SMTP_PASSWORD='a\\nb \"c\" # not a comment' # comment\n",
        );

        expect(result.values).toEqual({
            SMTP_PASSWORD: 'a\\nb "c" # not a comment',
        });
    });

    it("reports an unterminated quote as a bad line", () => {
        const result = parseUserEnv(
            "SMTP_PASSWORD=\"hunter2\nSMTP_USER='alice\nSMTP_HOST=smtp.example.test\n",
        );

        expect(result.badLines).toEqual([1, 2]);
        expect(result.values).toEqual({ SMTP_HOST: "smtp.example.test" });
    });

    it("reports text after a closing quote as a bad line", () => {
        const result = parseUserEnv('SMTP_PASSWORD="hunter2"extra\n');

        expect(result.badLines).toEqual([1]);
        expect(result.values).toEqual({});
    });

    it("accepts CRLF line endings, a BOM and = inside values", () => {
        const result = parseUserEnv(
            "﻿SMTP_HOST=smtp.example.test\r\nSMTP_PASSWORD=a=b=c # note\r\n",
        );

        expect(result.values).toEqual({
            SMTP_HOST: "smtp.example.test",
            SMTP_PASSWORD: "a=b=c",
        });
        expect(result.badLines).toEqual([]);
    });

    it("keeps the allow-list and the managed list disjoint", () => {
        for (const key of USER_ENV_ALLOWLIST) {
            expect(MANAGED_KEYS.has(key)).toBe(false);
        }
    });
});
