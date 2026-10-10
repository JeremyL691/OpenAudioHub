import { describe, expect, it } from "vitest";
import { compareVersions, isDowngrade } from "../src/main/versioning.js";

describe("compareVersions", () => {
    it("compares numbers part by part, not as text", () => {
        expect(compareVersions("1.10.0", "1.9.9")).toBeGreaterThan(0);
        expect(compareVersions("1.0.1", "1.1.0")).toBeLessThan(0);
        expect(compareVersions("1.1.0", "1.1")).toBe(0);
        expect(compareVersions("2.0.0", "2.0.0")).toBe(0);
    });

    it("rejects anything that is not a version", () => {
        expect(() => compareVersions("1.x.0", "1.0.0")).toThrow(
            "invalid version",
        );
        expect(() => compareVersions("1.-1.0", "1.0.0")).toThrow(
            "invalid version",
        );
        expect(() => compareVersions("", "1.0.0")).toThrow("invalid version");
        expect(() => compareVersions("1.0.0-", "1.0.0")).toThrow(
            "invalid version",
        );
    });

    it("accepts prerelease versions and orders them below the release", () => {
        expect(compareVersions("1.2.0-rc.1", "1.2.0")).toBeLessThan(0);
        expect(compareVersions("1.2.0", "1.2.0-rc.1")).toBeGreaterThan(0);
        expect(compareVersions("1.2.0-rc.1", "1.1.9")).toBeGreaterThan(0);
    });

    it("ignores build metadata", () => {
        expect(compareVersions("1.2.0+build.5", "1.2.0")).toBe(0);
        expect(compareVersions("1.2.0-rc.1+sha.abc", "1.2.0-rc.1")).toBe(0);
    });

    it("orders prerelease identifiers as semver does", () => {
        // numeric identifiers compare as numbers, not text
        expect(compareVersions("1.0.0-rc.10", "1.0.0-rc.9")).toBeGreaterThan(0);
        // numeric sorts below alphanumeric
        expect(compareVersions("1.0.0-1", "1.0.0-alpha")).toBeLessThan(0);
        // alphanumeric compares lexically
        expect(compareVersions("1.0.0-alpha", "1.0.0-beta")).toBeLessThan(0);
        // a longer list wins when the shared prefix is equal
        expect(compareVersions("1.0.0-rc", "1.0.0-rc.0")).toBeLessThan(0);
        expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.2")).toBe(0);
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

    it("treats a prerelease of the same release as older than the release", () => {
        expect(isDowngrade("1.2.0", "1.2.0-rc.1")).toBe(true);
        expect(isDowngrade("1.2.0-rc.1", "1.2.0")).toBe(false);
        expect(isDowngrade("1.2.0-rc.1", "1.2.0-rc.2")).toBe(false);
    });

    it("does not throw on a version it cannot parse", () => {
        expect(isDowngrade("garbage", "1.2.0")).toBe(false);
        expect(isDowngrade("1.2.0", "not-a-version!")).toBe(false);
    });
});
