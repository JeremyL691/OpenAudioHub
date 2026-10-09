import {
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    generateSecrets,
    loadOrCreateSecrets,
    SecretsError,
    validateSecrets,
} from "../src/main/secrets.js";

let dir: string;
let path: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oah-secrets-"));
    path = join(dir, "secrets.json");
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe("generateSecrets", () => {
    it("meets the length rules the web app enforces", () => {
        const secrets = validateSecrets(generateSecrets());
        expect(secrets.BETTER_AUTH_SECRET.length).toBeGreaterThanOrEqual(32);
        expect(secrets.ENCRYPTION_KEY).toMatch(/^[0-9a-f]{64}$/);
        expect(secrets.API_TOKEN_HASH_SECRET.length).toBeGreaterThanOrEqual(32);
        expect(secrets.POSTGRES_PASSWORD).toMatch(/^[A-Za-z0-9_-]+$/);
    });
});

describe("loadOrCreateSecrets", () => {
    it("creates secrets with 0600 permissions on the first launch", () => {
        const loaded = loadOrCreateSecrets({ path, databaseExists: false });

        expect(loaded.created).toBe(true);
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(validateSecrets(JSON.parse(readFileSync(path, "utf8")))).toEqual(
            loaded.secrets,
        );
    });

    it("loads the existing file without regenerating", () => {
        const first = loadOrCreateSecrets({ path, databaseExists: false });
        const second = loadOrCreateSecrets({ path, databaseExists: true });

        expect(second.created).toBe(false);
        expect(second.secrets).toEqual(first.secrets);
    });

    it("refuses to regenerate a missing file when the database exists", () => {
        expect(() =>
            loadOrCreateSecrets({ path, databaseExists: true }),
        ).toThrow(SecretsError);
        expect(() =>
            loadOrCreateSecrets({ path, databaseExists: true }),
        ).toThrow(/Restore it from a backup/);
        expect(readdirSync(dir)).toEqual([]);
    });

    it("keeps an unreadable file untouched when the database exists", () => {
        writeFileSync(path, "{ not json", { mode: 0o600 });

        expect(() =>
            loadOrCreateSecrets({ path, databaseExists: true }),
        ).toThrow(/not regenerated/);
        expect(readFileSync(path, "utf8")).toBe("{ not json");
    });

    it("moves an unreadable file aside and creates new secrets when no database exists yet", () => {
        writeFileSync(path, "{ not json", { mode: 0o600 });
        const now = new Date("2026-10-08T23:00:00.000Z");

        const loaded = loadOrCreateSecrets({
            path,
            databaseExists: false,
            now: () => now,
        });

        expect(loaded.created).toBe(true);
        expect(loaded.replacedCorruptFile).toBeDefined();
        expect(readFileSync(loaded.replacedCorruptFile as string, "utf8")).toBe(
            "{ not json",
        );
        expect(validateSecrets(JSON.parse(readFileSync(path, "utf8")))).toEqual(
            loaded.secrets,
        );
    });

    it("reports invalid entries by key name and never echoes a value", () => {
        const secrets = generateSecrets();
        const broken = {
            ...secrets,
            ENCRYPTION_KEY: "not-hex-secret-value-xyz",
        };
        writeFileSync(path, JSON.stringify(broken), { mode: 0o600 });

        let message = "";
        try {
            loadOrCreateSecrets({ path, databaseExists: true });
        } catch (error) {
            message = error instanceof Error ? error.message : String(error);
        }

        expect(message).toContain("ENCRYPTION_KEY");
        expect(message).not.toContain("not-hex-secret-value-xyz");
        expect(message).not.toContain(secrets.BETTER_AUTH_SECRET);
    });
});

describe("validateSecrets", () => {
    it("requires the schema version and the key lengths", () => {
        expect(() => validateSecrets({})).toThrow(/schemaVersion/);
        expect(() =>
            validateSecrets({
                ...generateSecrets(),
                BETTER_AUTH_SECRET: "short",
            }),
        ).toThrow(/BETTER_AUTH_SECRET/);
    });
});
