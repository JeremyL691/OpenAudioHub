import { readFileSync } from "node:fs";
import { writeFileAtomic } from "./atomic-file.js";

/**
 * Copies the secrets file to a path the user chose, with 0600 (D-309). Only runs after the user confirms
 * the export in the menu. The copy holds the same keys as secrets.json, so the caller must warn first.
 */
export function exportSecrets(secretsPath: string, targetPath: string): void {
    const text = readFileSync(secretsPath, "utf8");
    writeFileAtomic(targetPath, text, 0o600);
}
