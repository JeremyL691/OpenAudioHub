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
