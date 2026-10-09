import { execFileSync } from "node:child_process";

/** The attribute a browser download leaves on each file (D-346). */
export const QUARANTINE_ATTRIBUTE = "com.apple.quarantine";

/**
 * The .app bundle that contains this executable, or null when the process is not running from a bundle
 * (a development run). Electron's execPath is `<App>.app/Contents/MacOS/<name>`.
 */
export function bundleOf(executablePath: string): string | null {
    const match = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(executablePath);
    return match ? match[1] : null;
}

type Runner = (
    file: string,
    args: string[],
    options: { stdio: "ignore" },
) => unknown;

/**
 * Removes the quarantine attribute from the bundle and everything in it (D-346). The app does this for
 * its own bundle before any child process starts, because quarantined ad-hoc binaries are killed on first
 * run. Returns true when the attribute was present and removal was attempted. Throws when `xattr` fails.
 */
export function removeQuarantine(
    bundle: string,
    run: Runner = execFileSync as Runner,
): boolean {
    let present = true;
    try {
        run("xattr", ["-p", QUARANTINE_ATTRIBUTE, bundle], { stdio: "ignore" });
    } catch {
        // `xattr -p` exits non-zero when the attribute is absent on the bundle directory.
        present = false;
    }
    if (!present) return false;
    run("xattr", ["-dr", QUARANTINE_ATTRIBUTE, bundle], { stdio: "ignore" });
    return true;
}
