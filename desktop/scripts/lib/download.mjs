import { createHash } from "node:crypto";
import {
    createReadStream,
    createWriteStream,
    existsSync,
    mkdirSync,
    renameSync,
    rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** sha256 of a file as lowercase hex. */
export async function sha256File(path) {
    const hash = createHash("sha256");
    await pipeline(createReadStream(path), hash);
    return hash.digest("hex");
}

/**
 * Returns the cached path of `pin.file`, downloading it when absent. A cached or freshly
 * downloaded file is used only when its sha256 matches the pin; a mismatch is an error and
 * the partial file is removed.
 */
export async function fetchPinned(cacheDir, pin, { url = pin.url } = {}) {
    if (!url) throw new Error(`no download URL for ${pin.file}`);
    mkdirSync(cacheDir, { recursive: true });
    const target = join(cacheDir, pin.file);
    if (existsSync(target)) {
        if ((await sha256File(target)) === pin.sha256) return target;
        rmSync(target);
    }
    const partial = `${target}.partial`;
    mkdirSync(dirname(partial), { recursive: true });
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok || !response.body) {
        throw new Error(
            `download failed for ${pin.file}: HTTP ${response.status}`,
        );
    }
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
    const actual = await sha256File(partial);
    if (actual !== pin.sha256) {
        rmSync(partial);
        throw new Error(
            `sha256 mismatch for ${pin.file}: expected ${pin.sha256}, got ${actual}`,
        );
    }
    renameSync(partial, target);
    return target;
}

/** Verifies a file that is already on disk (for example one supplied by the user) against a pin. */
export async function verifyPinned(path, pin) {
    const actual = await sha256File(path);
    if (actual !== pin.sha256) {
        throw new Error(
            `sha256 mismatch for ${path}: expected ${pin.sha256}, got ${actual}`,
        );
    }
    return path;
}
