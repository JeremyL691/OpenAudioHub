import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";

/** True when `value` is an absolute path to an existing directory this process can write to. */
export async function isWritableFolder(value: unknown): Promise<boolean> {
    if (typeof value !== "string" || !path.isAbsolute(value)) return false;
    try {
        if (!(await stat(value)).isDirectory()) return false;
        await access(value, constants.W_OK);
        return true;
    } catch {
        return false;
    }
}
