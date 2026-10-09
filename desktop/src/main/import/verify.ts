import { createDecipheriv, createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, sep } from "node:path";
import { type ExportManifest, sha256File } from "./manifest.js";

/** Every regular file under `root`, as paths relative to it. */
function listFiles(root: string, prefix = ""): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(join(root, prefix), {
        withFileTypes: true,
    })) {
        const rel = join(prefix, entry.name);
        if (entry.isDirectory()) found.push(...listFiles(root, rel));
        else if (entry.isFile()) found.push(rel);
    }
    return found;
}

/**
 * Checks the audio files that the import extracted against the export's list (PLAN T15.2 step 5). Each listed
 * file must exist with the recorded size and sha256, and the archive must hold nothing that the list does not name.
 */
export function verifyStorageFiles(
    root: string,
    files: ExportManifest["storageFiles"],
): void {
    const listed = new Set<string>();
    for (const entry of files) {
        const rel = normalize(entry.path);
        if (isAbsolute(rel) || rel.split(sep).includes("..")) {
            throw new Error(
                "the export lists an audio file outside its folder",
            );
        }
        listed.add(rel);
        const full = join(root, rel);
        if (!existsSync(full)) {
            throw new Error(`audio file ${rel} is missing after extraction`);
        }
        if (statSync(full).size !== entry.bytes) {
            throw new Error(`audio file ${rel} has the wrong size`);
        }
        if (sha256File(full) !== entry.sha256) {
            throw new Error(`audio file ${rel} does not match its sha256`);
        }
    }
    for (const rel of listFiles(root)) {
        if (!listed.has(rel)) {
            throw new Error(
                `the archive holds ${rel}, which the export does not list`,
            );
        }
    }
}

/**
 * Decrypts the export's encryption check with the imported ENCRYPTION_KEY (PLAN T15.2 step 5). AES-256-GCM only
 * decrypts under the key it was made with, so a passing check proves the key matches the data before the switch.
 * The App's cipher is `iv:authTag:ciphertext` in hex (src/lib/encryption.ts).
 */
export function checkEncryptionSample(
    check: ExportManifest["encryptionCheck"],
    encryptionKey: string,
): void {
    const parts = check.ciphertext.split(":");
    if (parts.length !== 3) {
        throw new Error("the export's encryption check is malformed");
    }
    const [ivHex, tagHex, bodyHex] = parts;
    let plaintext: Buffer;
    try {
        const decipher = createDecipheriv(
            "aes-256-gcm",
            Buffer.from(encryptionKey, "hex"),
            Buffer.from(ivHex, "hex"),
        );
        decipher.setAuthTag(Buffer.from(tagHex, "hex"));
        plaintext = Buffer.concat([
            decipher.update(Buffer.from(bodyHex, "hex")),
            decipher.final(),
        ]);
    } catch {
        throw new Error(
            "the imported ENCRYPTION_KEY does not decrypt the export's check; the import is refused",
        );
    }
    const digest = createHash("sha256").update(plaintext).digest("hex");
    if (digest !== check.plaintextSha256) {
        throw new Error(
            "the export's encryption check decrypts to an unexpected value",
        );
    }
}
