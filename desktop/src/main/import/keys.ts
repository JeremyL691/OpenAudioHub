import type { DesktopSecrets } from "../secrets.js";

/** Parses KEY=VALUE lines (no quoting, no comments in exports). Malformed lines are an error. */
export function parseEnvLines(text: string): Record<string, string> {
    const values: Record<string, string> = {};
    for (const [index, raw] of text.split(/\r?\n/).entries()) {
        const line = raw.trim();
        if (line === "") continue;
        const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
        if (!match) throw new Error(`line ${index + 1} is not KEY=VALUE`);
        values[match[1]] = match[2];
    }
    return values;
}

/**
 * Merges the exported keys into the App's secrets (PLAN T15.2 step 7). The encryption and auth keys come from the
 * export, so encrypted data and sessions keep working. An export without API_TOKEN_HASH_SECRET falls back to the
 * old BETTER_AUTH_SECRET, as the Docker stack hashed API tokens with that key. The database password and the
 * pipeline token belong to this App's own database and stay as they are.
 */
export function mergeExportedKeys(
    current: DesktopSecrets,
    exported: Record<string, string>,
): DesktopSecrets {
    const encryptionKey = requireKey(exported, "ENCRYPTION_KEY");
    const authSecret = requireKey(exported, "BETTER_AUTH_SECRET");
    const tokenSecret = exported.API_TOKEN_HASH_SECRET || authSecret;
    return {
        ...current,
        ENCRYPTION_KEY: encryptionKey,
        BETTER_AUTH_SECRET: authSecret,
        API_TOKEN_HASH_SECRET: tokenSecret,
    };
}

function requireKey(values: Record<string, string>, name: string): string {
    const value = values[name];
    if (!value) throw new Error(`the export has no ${name}`);
    return value;
}
