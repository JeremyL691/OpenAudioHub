import { createCipheriv, createHash, randomBytes } from "node:crypto";
import {
    mkdirSync,
    mkdtempSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chooseUser } from "../src/main/import/bind.js";
import { mergeExportedKeys, parseEnvLines } from "../src/main/import/keys.js";
import {
    checkExportMigrations,
    EXPORT_FILES,
    readManifest,
    versionMigrationHashes,
} from "../src/main/import/manifest.js";
import {
    assertPlainTree,
    checkEncryptionSample,
    verifyStorageFiles,
} from "../src/main/import/verify.js";

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oah-import-pure-"));
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** The App's cipher (src/lib/encryption.ts): AES-256-GCM, `iv:authTag:ciphertext` in hex. */
const KEY = "ab".repeat(32);
const SAMPLE = "oah-desktop-export-check";
function encryptSample(keyHex: string, plaintext: string): string {
    const iv = randomBytes(16);
    const cipher = createCipheriv(
        "aes-256-gcm",
        Buffer.from(keyHex, "hex"),
        iv,
    );
    const body = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
    ]);
    return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${body.toString("hex")}`;
}

/** Writes a valid export folder; `contents` overrides a file's text. */
function writeExport(target: string, contents: Record<string, string> = {}) {
    mkdirSync(target, { recursive: true });
    const files: Record<string, { sha256: string; bytes: number }> = {};
    for (const name of EXPORT_FILES) {
        const text = contents[name] ?? `${name} content`;
        writeFileSync(join(target, name), text);
        files[name] = {
            sha256: sha(`${name} content`),
            bytes: Buffer.byteLength(text),
        };
    }
    writeFileSync(
        join(target, "manifest.json"),
        JSON.stringify({
            format: "openaudiohub-desktop-export",
            version: 2,
            exportedAt: "2026-10-09T00:00:00Z",
            sourceProject: "openaudiohub-rehearsal",
            sourceImage: "oah-baseline-app:d6fef64",
            sourceRevision: "unknown",
            migrations: { count: 0, hashes: [] },
            counts: { users: 1 },
            apiCredentialsDigest: "none",
            storageFiles: [],
            encryptionCheck: {
                ciphertext: encryptSample(KEY, SAMPLE),
                plaintextSha256: sha(SAMPLE),
            },
            files,
        }),
    );
    return target;
}

describe("readManifest", () => {
    it("accepts an export whose files match the manifest", () => {
        const manifest = readManifest(writeExport(join(dir, "export")));
        expect(manifest.sourceProject).toBe("openaudiohub-rehearsal");
    });

    it("refuses a file that does not match its recorded sha256", () => {
        const folder = writeExport(join(dir, "export"));
        writeFileSync(join(folder, "db.dump"), "tampered");

        expect(() => readManifest(folder)).toThrow("db.dump");
    });

    it("refuses a version 1 export and asks for a new one", () => {
        const folder = join(dir, "old");
        mkdirSync(folder);
        writeFileSync(
            join(folder, "manifest.json"),
            JSON.stringify({
                format: "openaudiohub-desktop-export",
                version: 1,
            }),
        );

        expect(() => readManifest(folder)).toThrow("Export again");
    });

    it("refuses a folder that is not an export", () => {
        const folder = join(dir, "other");
        mkdirSync(folder);
        writeFileSync(
            join(folder, "manifest.json"),
            JSON.stringify({ format: "x", version: 1 }),
        );

        expect(() => readManifest(folder)).toThrow(
            "not an OpenAudioHub desktop export",
        );
    });
});

describe("versionMigrationHashes", () => {
    it("hashes every migration file in name order and ignores the journal", () => {
        const migrations = join(dir, "migrations");
        mkdirSync(join(migrations, "meta"), { recursive: true });
        writeFileSync(join(migrations, "0001_b.sql"), "create table b ();");
        writeFileSync(join(migrations, "0000_a.sql"), "create table a ();");
        writeFileSync(join(migrations, "meta", "_journal.json"), "{}");

        expect(versionMigrationHashes(migrations)).toEqual([
            sha("create table a ();"),
            sha("create table b ();"),
        ]);
    });
});

describe("checkExportMigrations", () => {
    const known = [sha("create table a ();"), sha("create table b ();")];

    it("accepts an export whose migrations this version ships, in any order (Postgres records the order it applied them)", () => {
        expect(() =>
            checkExportMigrations([known[1], known[0]], known),
        ).not.toThrow();
    });

    it("accepts an export with fewer migrations than this version (the migrate step applies the rest)", () => {
        expect(() => checkExportMigrations([known[0]], known)).not.toThrow();
    });

    it("refuses an export with a migration this version does not have", () => {
        expect(() =>
            checkExportMigrations([known[0], sha("x")], known),
        ).toThrow("does not have");
    });
});

describe("parseEnvLines", () => {
    it("reads KEY=VALUE lines and skips blank lines", () => {
        expect(parseEnvLines("A=1\n\nB=two=2\n")).toEqual({
            A: "1",
            B: "two=2",
        });
    });

    it("names the line that is malformed", () => {
        expect(() => parseEnvLines("A=1\nnot a pair\n")).toThrow("line 2");
    });
});

describe("mergeExportedKeys", () => {
    const current = {
        schemaVersion: 1,
        POSTGRES_PASSWORD: "local-db-password",
        AUDIO_PIPELINE_TOKEN: "local-pipeline-token",
        BETTER_AUTH_SECRET: "local-auth",
        ENCRYPTION_KEY: "local-encryption",
        API_TOKEN_HASH_SECRET: "local-token-hash",
    };

    it("takes the encryption and auth keys from the export and keeps this App's database password", () => {
        const merged = mergeExportedKeys(current, {
            ENCRYPTION_KEY: "docker-encryption",
            BETTER_AUTH_SECRET: "docker-auth",
            API_TOKEN_HASH_SECRET: "docker-token-hash",
        });

        expect(merged.ENCRYPTION_KEY).toBe("docker-encryption");
        expect(merged.BETTER_AUTH_SECRET).toBe("docker-auth");
        expect(merged.API_TOKEN_HASH_SECRET).toBe("docker-token-hash");
        expect(merged.POSTGRES_PASSWORD).toBe("local-db-password");
        expect(merged.AUDIO_PIPELINE_TOKEN).toBe("local-pipeline-token");
    });

    it("falls back to the auth secret when the export has no token-hash secret", () => {
        const merged = mergeExportedKeys(current, {
            ENCRYPTION_KEY: "docker-encryption",
            BETTER_AUTH_SECRET: "docker-auth",
        });

        expect(merged.API_TOKEN_HASH_SECRET).toBe("docker-auth");
    });

    it("refuses an export without the encryption key", () => {
        expect(() =>
            mergeExportedKeys(current, { BETTER_AUTH_SECRET: "x" }),
        ).toThrow("no ENCRYPTION_KEY");
    });
});

describe("chooseUser", () => {
    const alice = {
        id: "u1",
        email: "Alice@example.test",
        createdAt: new Date(1),
    };
    const bob = { id: "u2", email: "bob@example.test", createdAt: new Date(2) };

    it("binds the only user", () => {
        expect(chooseUser([alice])).toBe(alice);
    });

    it("matches --user-email ignoring case", () => {
        expect(chooseUser([alice, bob], "alice@EXAMPLE.test")).toBe(alice);
    });

    it("asks for --user-email when there are several users", () => {
        expect(() => chooseUser([alice, bob])).toThrow("--user-email");
    });

    it("refuses an email that is not in the export", () => {
        expect(() => chooseUser([alice, bob], "carol@example.test")).toThrow(
            "no user",
        );
    });

    it("refuses an export with no users", () => {
        expect(() => chooseUser([])).toThrow("no user account");
    });
});

describe("assertPlainTree", () => {
    it("accepts a tree of plain files and folders", () => {
        const root = join(dir, "tree");
        mkdirSync(join(root, "nested", "deeper"), { recursive: true });
        writeFileSync(join(root, "nested", "deeper", "file.bin"), "x");

        expect(() => assertPlainTree(root)).not.toThrow();
    });

    it("refuses a symlink, even one that points at a file outside the tree", () => {
        const root = join(dir, "tree");
        mkdirSync(root);
        const outside = join(dir, "outside.txt");
        writeFileSync(outside, "secret");
        symlinkSync(outside, join(root, "link"));

        expect(() => assertPlainTree(root)).toThrow(
            "is not a regular file or folder",
        );
    });
});

describe("verifyStorageFiles", () => {
    /** A storage folder with one audio file; `listed` describes the export's entry for it. */
    function audioFolder(): string {
        const root = join(dir, "storage");
        mkdirSync(join(root, "uploads"), { recursive: true });
        writeFileSync(join(root, "uploads", "a.opus"), "audio a");
        return root;
    }
    const listed = (path: string, text: string) => ({
        path,
        sha256: sha(text),
        bytes: Buffer.byteLength(text),
    });

    it("accepts a folder whose files are exactly the listed ones", () => {
        const root = audioFolder();
        expect(() =>
            verifyStorageFiles(root, [listed("uploads/a.opus", "audio a")]),
        ).not.toThrow();
    });

    it("refuses a file whose content differs from the export", () => {
        const root = audioFolder();
        writeFileSync(join(root, "uploads", "a.opus"), "audio b");

        expect(() =>
            verifyStorageFiles(root, [listed("uploads/a.opus", "audio a")]),
        ).toThrow("does not match its sha256");
    });

    it("refuses a file that the export does not list", () => {
        const root = audioFolder();
        writeFileSync(join(root, "uploads", "extra.opus"), "extra");

        expect(() =>
            verifyStorageFiles(root, [listed("uploads/a.opus", "audio a")]),
        ).toThrow("does not list");
    });

    it("refuses a listed file that is missing", () => {
        const root = audioFolder();

        expect(() =>
            verifyStorageFiles(root, [listed("uploads/b.opus", "audio b")]),
        ).toThrow("is missing after extraction");
    });

    it("refuses a listed path that leaves the storage folder", () => {
        const root = audioFolder();

        expect(() =>
            verifyStorageFiles(root, [listed("../escape.opus", "x")]),
        ).toThrow("outside its folder");
    });

    it("refuses a listed audio file that is a symlink, even when the target has the same content", () => {
        const root = audioFolder();
        const target = join(dir, "target.opus");
        writeFileSync(target, "audio a");
        rmSync(join(root, "uploads", "a.opus"));
        symlinkSync(target, join(root, "uploads", "a.opus"));

        expect(() =>
            verifyStorageFiles(root, [listed("uploads/a.opus", "audio a")]),
        ).toThrow("is not a regular file or folder");
    });
});

describe("checkEncryptionSample", () => {
    const check = (ciphertext: string) => ({
        ciphertext,
        plaintextSha256: sha(SAMPLE),
    });

    it("accepts the key that made the sample", () => {
        expect(() =>
            checkEncryptionSample(check(encryptSample(KEY, SAMPLE)), KEY),
        ).not.toThrow();
    });

    it("refuses a key that does not decrypt the sample, without printing either key", () => {
        expect(() =>
            checkEncryptionSample(
                check(encryptSample(KEY, SAMPLE)),
                "cd".repeat(32),
            ),
        ).toThrow("does not decrypt");
    });

    it("refuses a sample that decrypts to something else", () => {
        expect(() =>
            checkEncryptionSample(
                check(encryptSample(KEY, "something else")),
                KEY,
            ),
        ).toThrow("unexpected value");
    });
});
