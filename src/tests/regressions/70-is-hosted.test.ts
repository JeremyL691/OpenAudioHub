/**
 * Issue #70 (IS_HOSTED env contract). The hosted switch and its billing,
 * Mynah, and admin variables were removed with the hosted surface.
 * The env schema must neither define nor read them.
 *
 * NEXT_PHASE is set so importing env.ts skips the runtime validation
 * (DATABASE_URL etc) -- we only need the schema here. Restored in afterAll.
 */

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

describe("issue #70: hosted-only env removed", () => {
    it("does not define IS_HOSTED", () => {
        expect(Object.keys(envSchema.shape)).not.toContain("IS_HOSTED");
    });

    it("ignores removed hosted variables instead of rejecting them", () => {
        const parsed = envSchema.parse({
            IS_HOSTED: "true",
            BILLING_ENABLED: "true",
            MYNAH_BASE_URL: "not-a-url",
            STRIPE_SECRET_KEY: "invalid",
        });
        expect(parsed).not.toHaveProperty("IS_HOSTED");
        expect(parsed).not.toHaveProperty("MYNAH_BASE_URL");
        expect(parsed).not.toHaveProperty("STRIPE_SECRET_KEY");
    });

    it("leaves WEBHOOKS_REQUIRE_PUBLIC_TARGETS unset by default", () => {
        expect(
            envSchema.parse({}).WEBHOOKS_REQUIRE_PUBLIC_TARGETS,
        ).toBeUndefined();
    });

    it("parses RATE_LIMIT_TRUST_PROXY_HEADERS as a strict optional boolean", () => {
        expect(
            envSchema.parse({ RATE_LIMIT_TRUST_PROXY_HEADERS: "true" })
                .RATE_LIMIT_TRUST_PROXY_HEADERS,
        ).toBe(true);
        expect(() =>
            envSchema.parse({ RATE_LIMIT_TRUST_PROXY_HEADERS: "yes" }),
        ).toThrow();
    });
});
