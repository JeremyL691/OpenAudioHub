import { describe, expect, it } from "vitest";
import {
    DESKTOP_LAUNCH_SECRET_MIN_LENGTH,
    validateDesktopEnv,
} from "@/lib/desktop/config";

const secret = "s".repeat(DESKTOP_LAUNCH_SECRET_MIN_LENGTH);

describe("validateDesktopEnv", () => {
    it("accepts a 32-character secret and a loopback APP_URL", () => {
        expect(() =>
            validateDesktopEnv({
                APP_URL: "http://127.0.0.1:38400",
                OAH_DESKTOP_LAUNCH_SECRET: secret,
            }),
        ).not.toThrow();
    });

    it("requires a launch secret of at least 32 characters", () => {
        expect(() =>
            validateDesktopEnv({
                APP_URL: "http://127.0.0.1:38400",
                OAH_DESKTOP_LAUNCH_SECRET: undefined,
            }),
        ).toThrow("OAH_DESKTOP_LAUNCH_SECRET must be at least 32 characters");

        expect(() =>
            validateDesktopEnv({
                APP_URL: "http://127.0.0.1:38400",
                OAH_DESKTOP_LAUNCH_SECRET: "s".repeat(31),
            }),
        ).toThrow("OAH_DESKTOP_LAUNCH_SECRET must be at least 32 characters");
    });

    it.each([
        "http://localhost:38400",
        "http://0.0.0.0:38400",
        "https://127.0.0.1:38400",
        "http://192.168.1.10:38400",
    ])("rejects APP_URL %s", (appUrl) => {
        expect(() =>
            validateDesktopEnv({
                APP_URL: appUrl,
                OAH_DESKTOP_LAUNCH_SECRET: secret,
            }),
        ).toThrow("APP_URL must be http://127.0.0.1:<port> when OAH_DESKTOP=1");
    });
});
