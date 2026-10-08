import { describe, expect, it, vi } from "vitest";
import { BRAND } from "@/lib/brand";
import {
    LEGACY_API_KEY_PREFIX,
    LEGACY_CONNECTOR_GLOBAL,
    LEGACY_PIPELINE_JOB_FIELD,
    LEGACY_SOURCE,
    LEGACY_STORAGE_KEYS,
    migrateLegacyStorageKey,
} from "@/lib/brand/legacy";

describe("brand constants", () => {
    it("names the product and points at the new repository", () => {
        expect(BRAND.name).toBe("OpenAudioHub");
        expect(BRAND.repoUrl).toBe(
            "https://github.com/JeremyL691/OpenAudioHub",
        );
        expect(BRAND.issuesUrl).toBe(`${BRAND.repoUrl}/issues`);
        expect(BRAND.docsPath).toBe("/docs");
    });

    it("keeps Riffado attribution in the copyright line", () => {
        expect(BRAND.copyright).toContain("Based on Riffado (AGPL-3.0)");
    });
});

describe("legacy identifiers", () => {
    it("preserves the values that existing data and clients still use", () => {
        expect(LEGACY_SOURCE).toBe("riffado");
        expect(LEGACY_API_KEY_PREFIX).toBe("op_");
        expect(LEGACY_CONNECTOR_GLOBAL).toBe("__riffadoConnector");
        expect(LEGACY_PIPELINE_JOB_FIELD).toBe("riffado_job_id");
        expect(LEGACY_STORAGE_KEYS).toEqual({
            lastSync: "riffado_last_sync",
            syncInProgress: "riffado_sync_in_progress",
            syncInterval: "riffado_sync_interval",
            autoSyncEnabled: "riffado_auto_sync_enabled",
        });
    });
});

function fakeWindow(initial: Record<string, string>) {
    const store = new Map(Object.entries(initial));
    vi.stubGlobal("window", {
        localStorage: {
            getItem: (key: string) => store.get(key) ?? null,
            setItem: (key: string, value: string) => void store.set(key, value),
            removeItem: (key: string) => void store.delete(key),
        },
    });
    return store;
}

describe("localStorage key migration", () => {
    it("copies a legacy value to the current key and removes the legacy key", () => {
        const store = fakeWindow({
            [LEGACY_STORAGE_KEYS.lastSync]: "2026-01-01T00:00:00Z",
        });
        migrateLegacyStorageKey(
            "openaudiohub:last-sync",
            LEGACY_STORAGE_KEYS.lastSync,
        );
        expect(store.get("openaudiohub:last-sync")).toBe(
            "2026-01-01T00:00:00Z",
        );
        expect(store.has(LEGACY_STORAGE_KEYS.lastSync)).toBe(false);
        vi.unstubAllGlobals();
    });

    it("keeps a value already stored under the current key", () => {
        const store = fakeWindow({
            [LEGACY_STORAGE_KEYS.syncInterval]: "600000",
            "openaudiohub:sync-interval": "300000",
        });
        migrateLegacyStorageKey(
            "openaudiohub:sync-interval",
            LEGACY_STORAGE_KEYS.syncInterval,
        );
        expect(store.get("openaudiohub:sync-interval")).toBe("300000");
        expect(store.has(LEGACY_STORAGE_KEYS.syncInterval)).toBe(false);
        vi.unstubAllGlobals();
    });

    it("does nothing without a window (server render)", () => {
        expect(() =>
            migrateLegacyStorageKey(
                "openaudiohub:last-sync",
                LEGACY_STORAGE_KEYS.lastSync,
            ),
        ).not.toThrow();
    });
});
