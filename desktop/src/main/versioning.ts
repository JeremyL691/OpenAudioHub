/**
 * Version checks for the data directory (PLAN T13.6). An app refuses to run against data that a newer
 * version wrote, because that version's migrations may not be understood here.
 */

interface ParsedVersion {
    /** Numeric major, minor, patch (and any further dotted numbers). Missing fields count as zero. */
    core: number[];
    /** Prerelease identifiers after the first "-", such as ["rc", "1"] for 1.2.0-rc.1. Empty for a release. */
    prerelease: string[];
}

function invalid(version: string): Error {
    return new Error(`invalid version: ${version}`);
}

/**
 * Parses a semver-style version. Build metadata after "+" is ignored, as semver requires, so that
 * `1.2.0+build.5` equals `1.2.0`. Prerelease identifiers may be alphanumeric, so `1.2.0-rc.1` is valid.
 */
function parse(version: string): ParsedVersion {
    const withoutBuild = version.split("+")[0] ?? "";
    const dash = withoutBuild.indexOf("-");
    const coreText = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash);
    const core = coreText.split(".").map((part) => {
        if (!/^\d+$/.test(part)) throw invalid(version);
        return Number.parseInt(part, 10);
    });
    const prerelease =
        dash === -1 ? [] : withoutBuild.slice(dash + 1).split(".");
    for (const identifier of prerelease) {
        if (!/^[0-9A-Za-z-]+$/.test(identifier)) throw invalid(version);
    }
    return { core, prerelease };
}

/**
 * Orders prerelease identifiers as semver does: compared left to right, numeric identifiers compare
 * as numbers and sort below alphanumeric ones, and a longer list wins when the shared prefix is equal.
 */
function comparePrerelease(a: string[], b: string[]): number {
    const length = Math.max(a.length, b.length);
    for (let index = 0; index < length; index += 1) {
        const left = a[index];
        const right = b[index];
        if (left === undefined) return -1;
        if (right === undefined) return 1;
        const leftNumeric = /^\d+$/.test(left);
        const rightNumeric = /^\d+$/.test(right);
        if (leftNumeric && rightNumeric) {
            const difference = Number(left) - Number(right);
            if (difference !== 0) return difference < 0 ? -1 : 1;
        } else if (leftNumeric) {
            return -1;
        } else if (rightNumeric) {
            return 1;
        } else if (left !== right) {
            return left < right ? -1 : 1;
        }
    }
    return 0;
}

/**
 * Compares versions by semver precedence: negative when a < b, zero when equal, positive when a > b.
 * A prerelease sorts below its release, so 1.2.0-rc.1 < 1.2.0. Throws on text that is not a version.
 */
export function compareVersions(a: string, b: string): number {
    const left = parse(a);
    const right = parse(b);
    const length = Math.max(left.core.length, right.core.length);
    for (let index = 0; index < length; index += 1) {
        const difference = (left.core[index] ?? 0) - (right.core[index] ?? 0);
        if (difference !== 0) return difference < 0 ? -1 : 1;
    }
    if (left.prerelease.length === 0 && right.prerelease.length === 0) {
        return 0;
    }
    if (left.prerelease.length === 0) return 1;
    if (right.prerelease.length === 0) return -1;
    return comparePrerelease(left.prerelease, right.prerelease);
}

/**
 * True when the data was written by a newer app than the one running now.
 *
 * A version that cannot be parsed is not treated as a downgrade. The caller refuses to start on true,
 * so throwing here would stop the app on every launch with no way to recover from inside the app, and
 * the next successful start overwrites lastVersion anyway. The check is a guard against accidents, not
 * a security boundary, so failing open on text it cannot read is the safer trade-off.
 */
export function isDowngrade(dataVersion: string, appVersion: string): boolean {
    try {
        return compareVersions(appVersion, dataVersion) < 0;
    } catch {
        return false;
    }
}
