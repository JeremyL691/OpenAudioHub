import { describe, expect, it } from "vitest";
import { parseCli } from "../src/main/cli.js";

const app = ["/Applications/OpenAudioHub.app/Contents/MacOS/OpenAudioHub"];

describe("parseCli", () => {
    it("returns null for a normal start, whatever Electron and Chromium add", () => {
        expect(
            parseCli([...app, "--remote-debugging-port=9222", "-psn_0_12345"]),
        ).toBeNull();
    });

    it("reads an import with its folder and the account to sign in as", () => {
        expect(
            parseCli([
                ...app,
                "--import",
                "/exports/one",
                "--user-email",
                "me@example.test",
            ]),
        ).toEqual({
            command: {
                kind: "import",
                dir: "/exports/one",
                userEmail: "me@example.test",
                thenOpen: false,
            },
        });
    });

    it("marks the menu's restart with --then-open, so the App opens after the import", () => {
        expect(
            parseCli([...app, "--import", "/exports/one", "--then-open"]),
        ).toEqual({
            command: {
                kind: "import",
                dir: "/exports/one",
                thenOpen: true,
            },
        });
    });

    it("reads a rollback", () => {
        expect(parseCli([...app, "--rollback-import"])).toEqual({
            command: { kind: "rollback" },
        });
    });

    it("refuses a command line it cannot run, and says why", () => {
        expect(parseCli([...app, "--import"])).toEqual({
            error: "--import needs the export folder",
        });
        expect(
            parseCli([...app, "--import", "--user-email", "me@example.test"]),
        ).toEqual({ error: "--import needs the export folder" });
        expect(parseCli([...app, "--user-email", "me@example.test"])).toEqual({
            error: "--import <dir> is needed",
        });
        expect(parseCli([...app, "--then-open"])).toEqual({
            error: "--import <dir> is needed",
        });
        expect(
            parseCli([...app, "--import", "/exports/one", "--user-email"]),
        ).toEqual({ error: "--user-email needs an address" });
        expect(
            parseCli([...app, "--import", "/exports/one", "--rollback-import"]),
        ).toEqual({
            error: "--import and --rollback-import cannot be used together",
        });
        expect(
            parseCli([
                ...app,
                "--rollback-import",
                "--user-email",
                "me@example.test",
            ]),
        ).toEqual({ error: "--user-email only applies to --import" });
    });
});
