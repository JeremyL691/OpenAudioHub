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
        const value = parseValue(rawValue);
        if (value === null) {
            badLines.push(index + 1);
            return;
        }
        values[key] = value;
    });
    return { values, unknownKeys, managedKeys, badLines };
}

/** Escapes recognised inside double quotes. Any other backslash is kept as written. */
const DOUBLE_QUOTE_ESCAPES: ReadonlyMap<string, string> = new Map([
    ["n", "\n"],
    ["t", "\t"],
    ["\\", "\\"],
    ['"', '"'],
]);

/**
 * Reads the text after `KEY=` the way Docker Compose reads env_file, so a file that works for the
 * containers also works here. Returns null when a quoted value is unterminated or has trailing text.
 *
 * - Unquoted: an inline comment starts at a `#` preceded by whitespace; a `#` inside a word is kept.
 * - Double-quoted: escapes apply, and only whitespace or a comment may follow the closing quote.
 * - Single-quoted: literal text up to the next single quote, with no escapes.
 */
function parseValue(rawValue: string): string | null {
    const value = rawValue.trimStart();
    const quote = value[0];
    if (quote === '"' || quote === "'") {
        return parseQuoted(value, quote);
    }
    return rawValue.replace(/\s#.*$/, "").trim();
}

function parseQuoted(value: string, quote: string): string | null {
    let result = "";
    for (let index = 1; index < value.length; index += 1) {
        const char = value[index];
        if (quote === '"' && char === "\\" && index + 1 < value.length) {
            const escaped = DOUBLE_QUOTE_ESCAPES.get(value[index + 1]);
            if (escaped !== undefined) {
                result += escaped;
                index += 1;
                continue;
            }
        }
        if (char === quote) {
            const rest = value.slice(index + 1);
            return /^\s*(#.*)?$/.test(rest) ? result : null;
        }
        result += char;
    }
    return null;
}
