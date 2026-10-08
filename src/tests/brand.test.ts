import { describe, expect, it } from "vitest";
import { BRAND } from "@/lib/brand";
import {
    LEGACY_API_KEY_PREFIX,
    LEGACY_CONNECTOR_GLOBAL,
    LEGACY_PIPELINE_JOB_FIELD,
    LEGACY_SOURCE,
    LEGACY_STORAGE_KEYS,
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
