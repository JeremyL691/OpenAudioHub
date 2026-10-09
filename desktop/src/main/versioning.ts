/**
 * Version checks for the data directory (PLAN T13.6). An app refuses to run against data that a newer
 * version wrote, because that version's migrations may not be understood here.
 */

function parts(version: string): number[] {
    return version.split(".").map((part) => {
        const value = Number.parseInt(part, 10);
        if (!/^\d+$/.test(part) || !Number.isFinite(value)) {
            throw new Error(`invalid version: ${version}`);
        }
        return value;
    });
}

/** Compares dotted numeric versions: negative when a < b, zero when equal, positive when a > b. */
export function compareVersions(a: string, b: string): number {
    const left = parts(a);
    const right = parts(b);
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
        const difference = (left[index] ?? 0) - (right[index] ?? 0);
        if (difference !== 0) return difference < 0 ? -1 : 1;
    }
    return 0;
}

/** True when the data was written by a newer app than the one running now. */
export function isDowngrade(dataVersion: string, appVersion: string): boolean {
    return compareVersions(appVersion, dataVersion) < 0;
}
