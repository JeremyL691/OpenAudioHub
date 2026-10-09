import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { writeFileAtomic } from "./atomic-file.js";

export const SECRETS_SCHEMA_VERSION = 1;

/** Names match the environment variables the web app reads (PLAN §20, D-309). */
export const SECRET_KEYS = [
    "BETTER_AUTH_SECRET",
    "ENCRYPTION_KEY",
    "API_TOKEN_HASH_SECRET",
    "AUDIO_PIPELINE_TOKEN",
    "POSTGRES_PASSWORD",
] as const;

export type SecretKey = (typeof SECRET_KEYS)[number];

export interface DesktopSecrets extends Record<SecretKey, string> {
    schemaVersion: number;
}

export type SecretsFailure =
    | "missing-with-database"
    | "corrupt-with-database"
    | "invalid";

export class SecretsError extends Error {
    constructor(
        message: string,
        readonly reason: SecretsFailure,
    ) {
        super(message);
        this.name = "SecretsError";
    }
}

/**
 * Fresh secrets with the lengths the web app requires. ENCRYPTION_KEY must be 64 hex characters
 * (32 bytes); BETTER_AUTH_SECRET and API_TOKEN_HASH_SECRET need at least 32 characters.
 */
export function generateSecrets(
    random: (size: number) => Buffer = randomBytes,
): DesktopSecrets {
    return {
        schemaVersion: SECRETS_SCHEMA_VERSION,
        BETTER_AUTH_SECRET: random(32).toString("hex"),
        ENCRYPTION_KEY: random(32).toString("hex"),
        API_TOKEN_HASH_SECRET: random(32).toString("hex"),
        AUDIO_PIPELINE_TOKEN: random(32).toString("base64url"),
        POSTGRES_PASSWORD: random(24).toString("hex"),
    };
}

/**
 * Checks shape and lengths. Error messages name the keys that failed and never include values.
 */
export function validateSecrets(value: unknown): DesktopSecrets {
    if (!value || typeof value !== "object") {
        throw new SecretsError("secrets file is not an object", "invalid");
    }
    const raw = value as Record<string, unknown>;
    const problems: string[] = [];
    if (raw.schemaVersion !== SECRETS_SCHEMA_VERSION)
        problems.push("schemaVersion");
    const text = (key: SecretKey): string | undefined =>
        typeof raw[key] === "string" ? (raw[key] as string) : undefined;

    const betterAuth = text("BETTER_AUTH_SECRET");
    if (!betterAuth || betterAuth.length < 32)
        problems.push("BETTER_AUTH_SECRET");

    const encryption = text("ENCRYPTION_KEY");
    if (!encryption || !/^[0-9a-fA-F]{64}$/.test(encryption))
        problems.push("ENCRYPTION_KEY");

    const hashSecret = text("API_TOKEN_HASH_SECRET");
    if (!hashSecret || hashSecret.length < 32)
        problems.push("API_TOKEN_HASH_SECRET");

    const pipelineToken = text("AUDIO_PIPELINE_TOKEN");
    if (!pipelineToken) problems.push("AUDIO_PIPELINE_TOKEN");

    const postgresPassword = text("POSTGRES_PASSWORD");
    if (!postgresPassword || !/^[A-Za-z0-9_-]+$/.test(postgresPassword))
        problems.push("POSTGRES_PASSWORD");

    if (problems.length > 0) {
        throw new SecretsError(
            `secrets file has invalid entries: ${problems.join(", ")}`,
            "invalid",
        );
    }
    return {
        schemaVersion: SECRETS_SCHEMA_VERSION,
        BETTER_AUTH_SECRET: betterAuth as string,
        ENCRYPTION_KEY: encryption as string,
        API_TOKEN_HASH_SECRET: hashSecret as string,
        AUDIO_PIPELINE_TOKEN: pipelineToken as string,
        POSTGRES_PASSWORD: postgresPassword as string,
    };
}

export function saveSecrets(path: string, secrets: DesktopSecrets): void {
    writeFileAtomic(path, `${JSON.stringify(secrets, null, 2)}\n`, 0o600);
}

export interface LoadSecretsInput {
    path: string;
    /** True once the database cluster exists. Encrypted rows are then unreadable without the same key. */
    databaseExists: boolean;
    generate?: () => DesktopSecrets;
    now?: () => Date;
}

export interface LoadedSecrets {
    secrets: DesktopSecrets;
    created: boolean;
    /** The unreadable file moved aside before secrets were regenerated (only without a database). */
    replacedCorruptFile?: string;
}

/**
 * Loads secrets.json, or creates it on the first launch. Regeneration happens only when no database
 * exists yet. With a database present, a missing or unreadable file is an error: a new key would make
 * the stored encrypted values unreadable, so the operator must restore the file from a backup.
 */
export function loadOrCreateSecrets(input: LoadSecretsInput): LoadedSecrets {
    const generate = input.generate ?? (() => generateSecrets());
    const now = input.now ?? (() => new Date());

    if (!existsSync(input.path)) {
        if (input.databaseExists) {
            throw new SecretsError(
                "secrets.json is missing but the database exists. Restore it from a backup; it was not regenerated.",
                "missing-with-database",
            );
        }
        const secrets = generate();
        saveSecrets(input.path, secrets);
        return { secrets, created: true };
    }

    let problem: string | null = null;
    try {
        const parsed = validateSecrets(
            JSON.parse(readFileSync(input.path, "utf8")),
        );
        return { secrets: parsed, created: false };
    } catch (error) {
        // JSON.parse errors can quote file content, so only the fixed reasons below are reported.
        problem =
            error instanceof SecretsError
                ? error.message
                : "secrets file is not valid JSON";
    }

    if (input.databaseExists) {
        throw new SecretsError(
            `secrets.json cannot be used (${problem}). The database exists, so it was not regenerated. Restore it from a backup.`,
            "corrupt-with-database",
        );
    }
    const stamp = now().toISOString().replace(/[:.]/g, "-");
    const moved = `${input.path}.corrupt-${stamp}`;
    renameSync(input.path, moved);
    const secrets = generate();
    saveSecrets(input.path, secrets);
    return { secrets, created: true, replacedCorruptFile: moved };
}
