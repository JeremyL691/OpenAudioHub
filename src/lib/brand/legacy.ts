/**
 * Identifiers inherited from the Riffado fork. Compatibility paths read
 * these, and nothing writes them. This is the only source file that names
 * the legacy brand, apart from the migrations, docs, and the brand-audit
 * allowlist (see T2.10).
 */

/** `transcriptions.source` and related columns, before the rename. */
export const LEGACY_SOURCE = "riffado" as const;

/** API key prefix before `oah_`. Keys with this prefix still authenticate. */
export const LEGACY_API_KEY_PREFIX = "op_" as const;

/** Browser localStorage keys written before the rename. */
export const LEGACY_STORAGE_KEYS = {
    lastSync: "riffado_last_sync",
    syncInProgress: "riffado_sync_in_progress",
    syncInterval: "riffado_sync_interval",
    autoSyncEnabled: "riffado_auto_sync_enabled",
} as const;

/** Window global set by the browser extension before the rename. */
export const LEGACY_CONNECTOR_GLOBAL = "__riffadoConnector" as const;

/** Pipeline job column and request field before the rename. */
export const LEGACY_PIPELINE_JOB_FIELD = "riffado_job_id" as const;

/** Attribution line shown in the footer and copyright. */
export const LEGACY_ATTRIBUTION = "Based on Riffado (AGPL-3.0)" as const;

/** Original browser extension repository, linked as third-party attribution. */
export const LEGACY_CONNECTOR_REPO_URL =
    "https://github.com/riffado/connector" as const;

/**
 * Moves one persisted value from its pre-rename localStorage key to the
 * current key: copy when the current key is empty, then remove the legacy key.
 * A no-op once the legacy key is gone, and when storage is unavailable.
 */
export function migrateLegacyStorageKey(current: string, legacy: string): void {
    if (typeof window === "undefined") return;
    try {
        const storage = window.localStorage;
        const legacyValue = storage.getItem(legacy);
        if (legacyValue === null) return;
        if (storage.getItem(current) === null) {
            storage.setItem(current, legacyValue);
        }
        storage.removeItem(legacy);
    } catch {
        // Private mode and blocked site data throw; the current key is then
        // simply unset and the default applies.
    }
}
