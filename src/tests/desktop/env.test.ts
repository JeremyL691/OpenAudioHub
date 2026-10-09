import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type EnvSchema = typeof import("@/lib/env")["envSchema"];
let envSchema: EnvSchema;
let originalNextPhase: string | undefined;

beforeAll(async () => {
    originalNextPhase = process.env.NEXT_PHASE;
    process.env.NEXT_PHASE = "phase-production-build";
    ({ envSchema } = await import("@/lib/env"));
});

afterAll(() => {
    if (originalNextPhase === undefined) {
        delete process.env.NEXT_PHASE;
    } else {
        process.env.NEXT_PHASE = originalNextPhase;
    }
});

describe("desktop environment flags", () => {
    it("parses to the same values as before the desktop mode when OAH_DESKTOP is unset", () => {
        const baseline = JSON.parse(
            readFileSync(
                new URL("./env-baseline.json", import.meta.url),
                "utf8",
            ),
        ) as Record<string, unknown>;

        const parsed = JSON.parse(JSON.stringify(envSchema.parse({})));

        expect(parsed).toEqual(baseline);
    });

    it.each([undefined, "", "0"])("treats OAH_DESKTOP=%j as off", (value) => {
        const parsed = envSchema.parse({ OAH_DESKTOP: value });

        expect(parsed.OAH_DESKTOP).toBeUndefined();
    });

    it('turns desktop mode on only for "1"', () => {
        expect(envSchema.parse({ OAH_DESKTOP: "1" }).OAH_DESKTOP).toBe(true);
    });

    it.each(["true", "yes", "2"])("rejects OAH_DESKTOP=%j", (value) => {
        expect(() => envSchema.parse({ OAH_DESKTOP: value })).toThrow(
            /OAH_DESKTOP must be/,
        );
    });

    it("keeps the launch secret and bound user id as given, and empty means unset", () => {
        const parsed = envSchema.parse({
            OAH_DESKTOP_LAUNCH_SECRET: "x".repeat(40),
            OAH_DESKTOP_USER_ID: "user_123",
        });
        expect(parsed.OAH_DESKTOP_LAUNCH_SECRET).toBe("x".repeat(40));
        expect(parsed.OAH_DESKTOP_USER_ID).toBe("user_123");

        const empty = envSchema.parse({
            OAH_DESKTOP_LAUNCH_SECRET: "",
            OAH_DESKTOP_USER_ID: "",
        });
        expect(empty.OAH_DESKTOP_LAUNCH_SECRET).toBeUndefined();
        expect(empty.OAH_DESKTOP_USER_ID).toBeUndefined();
    });
});
