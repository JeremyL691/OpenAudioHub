/**
 * Parses the user's `openaudiohub.env` (PLAN D-311). Only keys on the allow-list reach the server.
 * Keys the supervisor manages are refused, because the app sets them itself. Errors name keys and
 * line numbers, never values.
 */

/** Settings that were environment variables in Docker and move to the file on desktop (D-311). */
export const USER_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
    "DEFAULT_STORAGE_TYPE",
    "S3_ENDPOINT",
    "S3_BUCKET",
    "S3_REGION",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_SECURE",
    "SMTP_USER",
    "SMTP_PASSWORD",
    "SMTP_FROM",
    "SMTP_REPLY_TO",
    "WEBSHARE_API_KEY",
    "PLAUD_PROXY_SCOPE",
    "PLAUD_SYNC_RATE_LIMIT_PER_MINUTE",
    "BACKGROUND_SYNC_ENABLED",
    "BACKGROUND_SYNC_INTERVAL_MS",
    "WHISPER_MAX_BYTES",
    "WHISPER_COMPRESS_BITRATE_KBPS",
    "WHISPER_REQUEST_TIMEOUT_MS",
    "AUTO_SUMMARY_RATE_LIMIT_PER_HOUR",
    "WEBHOOKS_REQUIRE_PUBLIC_TARGETS",
    "DISABLE_UPDATE_CHECK",
    "OPENCODE_GO_SESSION_ID",
    "AUDIO_PIPELINE_ENABLED",
]);

/** Keys the supervisor sets itself. A user value would conflict with the managed configuration. */
export const MANAGED_KEYS: ReadonlySet<string> = new Set([
    "DATABASE_URL",
    "APP_URL",
    "PORT",
    "HOSTNAME",
    "OAH_LISTEN_HOST",
    "OAH_DESKTOP",
    "OAH_DESKTOP_LAUNCH_SECRET",
    "OAH_DESKTOP_USER_ID",
    "BETTER_AUTH_SECRET",
    "ENCRYPTION_KEY",
    "API_TOKEN_HASH_SECRET",
    "AUDIO_PIPELINE_TOKEN",
    "AUDIO_PIPELINE_BASE_URL",
    "AUDIO_PIPELINE_CORE_URL",
    "AUDIO_PIPELINE_DATA_DIR",
    "LOCAL_STORAGE_PATH",
    "POSTGRES_PASSWORD",
    "NODE_ENV",
    "TZ",
    "PATH",
]);

export interface UserEnvResult {
    values: Record<string, string>;
    /** Keys that are not on the allow-list (the value is not included). */
    unknownKeys: string[];
    /** Keys the app manages (the value is not included). */
    managedKeys: string[];
    /** Line numbers with a syntax error. */
    badLines: number[];
}

export function parseUserEnv(text: string): UserEnvResult {
    const values: Record<string, string> = {};
    const unknownKeys: string[] = [];
    const managedKeys: string[] = [];
    const badLines: number[] = [];
    const lines = text.split(/\r?\n/);
    lines.forEach((raw, index) => {
        const line = raw.trim();
        if (line === "" || line.startsWith("#")) return;
        const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
        if (!match) {
            badLines.push(index + 1);
            return;
        }
        const [, key, rawValue] = match;
        if (MANAGED_KEYS.has(key)) {
            managedKeys.push(key);
            return;
        }
        if (!USER_ENV_ALLOWLIST.has(key)) {
            unknownKeys.push(key);
            return;
        }
        values[key] = unquote(rawValue);
    });
    return { values, unknownKeys, managedKeys, badLines };
}

function unquote(value: string): string {
    const trimmed = value.trim();
    if (trimmed.length >= 2) {
        const first = trimmed[0];
        const last = trimmed[trimmed.length - 1];
        if (
            (first === '"' && last === '"') ||
            (first === "'" && last === "'")
        ) {
            return trimmed.slice(1, -1);
        }
    }
    return trimmed;
}
