import { describe, expect, it } from "vitest";
import { compareVersions, isDowngrade } from "../src/main/versioning.js";

describe("compareVersions", () => {
    it("compares numbers part by part, not as text", () => {
        expect(compareVersions("1.10.0", "1.9.9")).toBeGreaterThan(0);
        expect(compareVersions("1.0.1", "1.1.0")).toBeLessThan(0);
        expect(compareVersions("1.1.0", "1.1")).toBe(0);
        expect(compareVersions("2.0.0", "2.0.0")).toBe(0);
    });

    it("rejects anything that is not dotted digits", () => {
        expect(() => compareVersions("1.x.0", "1.0.0")).toThrow(
            "invalid version",
        );
        expect(() => compareVersions("1.-1.0", "1.0.0")).toThrow(
            "invalid version",
        );
    });
});

describe("isDowngrade", () => {
    it("refuses data written by a newer version", () => {
        expect(isDowngrade("1.1.0", "1.0.1")).toBe(true);
    });

    it("allows the same version and an upgrade", () => {
        expect(isDowngrade("1.1.0", "1.1.0")).toBe(false);
        expect(isDowngrade("1.0.1", "1.1.0")).toBe(false);
    });
});
