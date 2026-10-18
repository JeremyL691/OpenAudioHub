import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const manifest = JSON.parse(readFileSync(join(root, "dist/manifest.json"), "utf8")) as Record<string, unknown>;
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };

function filesIn(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? filesIn(path) : [path];
    });
}

describe("release manifest", () => {
    it("has the exact permissions", () => {
        expect(manifest.permissions).toEqual(["activeTab", "scripting", "cookies", "storage", "alarms"]);
    });

    it("has the exact host permissions", () => {
        expect(manifest.host_permissions).toEqual(["https://*.plaud.ai/*", "https://*.plaud.cn/*"]);
    });

    it("has the required identity and background fields", () => {
        expect(manifest.manifest_version).toBe(3);
        expect(manifest.name).toBe("OpenAudioHub");
        expect(manifest.minimum_chrome_version).toBe("120");
        expect(manifest.version).toBe(pkg.version);
        expect(manifest.background).toEqual({ service_worker: "worker.js", type: "module" });
        expect(manifest.action).toMatchObject({ default_popup: "popup.html", default_title: "OpenAudioHub" });
    });

    it("has none of the forbidden fields", () => {
        for (const field of [
            "content_scripts",
            "optional_host_permissions",
            "tabs",
            "webRequest",
            "externally_connectable",
            "key",
        ]) {
            expect(manifest, field).not.toHaveProperty(field);
        }
        expect(JSON.stringify(manifest)).not.toContain("<all_urls>");
    });

    it("ships no test code or test-only options", () => {
        const files = filesIn(join(root, "dist"));
        const text = files.map((file) => readFileSync(file, "utf8")).join("\n");
        expect(files.filter((file) => readFileSync(file, "utf8").includes("OAH_TEST"))).toEqual([]);
        expect(text).not.toContain("timeoutMs");
        expect(text).not.toContain(":3298");
    });
});
