/**
 * Bitrate of the MP3 made for downloads and auto-export. Lives here, not in
 * ffmpeg.ts, so client components can estimate sizes without pulling in node:child_process.
 */
export const DOWNLOAD_MP3_KBPS = 128;

/** Approximate MP3 size in bytes for a recording of `durationMs` at the download bitrate. */
export function estimateMp3Bytes(durationMs: number): number {
    if (!Number.isFinite(durationMs) || durationMs <= 0) return 0;
    return Math.round(((durationMs / 1000) * DOWNLOAD_MP3_KBPS * 1000) / 8);
}
