import { afterEach, describe, expect, it, vi } from "vitest";
import {
    fetchLatestReleaseTag,
    INSTALL_SCRIPT_HEADERS,
    isValidVersionTag,
    renderInstallScript,
} from "@/lib/install-script";

// The installer and its update check (F22). The check is silent on every failure.
describe("install script", () => {
    it("accepts only release tags of the form vX.Y.Z", () => {
        expect(isValidVersionTag("v1.2.3")).toBe(true);
        expect(isValidVersionTag("1.2.3")).toBe(false);
        expect(isValidVersionTag("v1.2")).toBe(false);
        expect(isValidVersionTag("v1.2.3-rc1")).toBe(false);
    });

    it("renders the version into the bundled installer", async () => {
        const script = await renderInstallScript("v1.2.3");
        expect(script).toContain("v1.2.3");
        expect(script).not.toContain("{{VERSION}}");
    });

    it("serves the installer as a cacheable shell script", () => {
        expect(INSTALL_SCRIPT_HEADERS["Content-Type"]).toContain(
            "text/x-shellscript",
        );
        expect(INSTALL_SCRIPT_HEADERS["X-Content-Type-Options"]).toBe(
            "nosniff",
        );
    });

    describe("update check", () => {
        afterEach(() => {
            vi.unstubAllGlobals();
        });

        it("returns the latest release tag", async () => {
            vi.stubGlobal(
                "fetch",
                vi.fn(
                    async () =>
                        new Response(JSON.stringify({ tag_name: "v1.2.3" }), {
                            status: 200,
                        }),
                ),
            );
            await expect(fetchLatestReleaseTag()).resolves.toBe("v1.2.3");
        });

        it("is silent when there is no release yet", async () => {
            vi.stubGlobal(
                "fetch",
                vi.fn(async () => new Response("", { status: 404 })),
            );
            await expect(fetchLatestReleaseTag()).resolves.toBeNull();
        });

        it("ignores a tag that is not a release version", async () => {
            vi.stubGlobal(
                "fetch",
                vi.fn(
                    async () =>
                        new Response(JSON.stringify({ tag_name: "nightly" }), {
                            status: 200,
                        }),
                ),
            );
            await expect(fetchLatestReleaseTag()).resolves.toBeNull();
        });

        it("is silent when the network fails", async () => {
            vi.stubGlobal(
                "fetch",
                vi.fn(async () => {
                    throw new TypeError("fetch failed");
                }),
            );
            await expect(fetchLatestReleaseTag()).resolves.toBeNull();
        });
    });
});
