import {
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportSecrets } from "../src/main/export-keys.js";

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oah-export-keys-"));
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe("exportSecrets", () => {
    it("copies the secrets to the chosen path with 0600", () => {
        const secrets = join(dir, "secrets.json");
        const target = join(dir, "backup", "keys.json");
        const content = JSON.stringify({ ENCRYPTION_KEY: "x".repeat(64) });
        writeFileSync(secrets, content, { mode: 0o600 });

        exportSecrets(secrets, target);

        expect(readFileSync(target, "utf8")).toBe(content);
        expect(statSync(target).mode & 0o777).toBe(0o600);
    });
});
