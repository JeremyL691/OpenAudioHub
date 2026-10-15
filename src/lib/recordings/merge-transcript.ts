import type { TimelineSegment } from "@/lib/transcription/audio-pipeline-repair";

export interface TranscriptPart {
    text: string;
    timeline: TimelineSegment[] | null;
}

/** Pick the transcript to carry over for one recording: the preferred source first, else the newest of the others. Returns null when the recording has none. */
export function pickTranscript<T extends { source: string; createdAt: Date }>(
    rows: readonly T[],
    preferredSource: string,
): T | null {
    const newest = (list: readonly T[]) =>
        list.reduce<T | null>(
            (best, row) =>
                !best || row.createdAt > best.createdAt ? row : best,
            null,
        );
    const preferred = rows.filter((row) => row.source === preferredSource);
    return newest(preferred.length > 0 ? preferred : rows);
}

/** Join per-recording transcripts in merge order. Null when any recording lacks one. */
export function stitchTranscripts(
    parts: readonly (TranscriptPart | null)[],
    offsetsMs: readonly number[],
): { text: string; timeline: TimelineSegment[] | null } | null {
    if (parts.length !== offsetsMs.length) {
        throw new Error(
            "stitchTranscripts: parts and offsetsMs length mismatch",
        );
    }
    if (parts.some((part) => part === null)) return null;
    const done = parts as TranscriptPart[];

    const text = done.map((part) => part.text.trim()).join("\n\n");
    const timeline = done.every(
        (part) => part.timeline && part.timeline.length > 0,
    )
        ? done.flatMap((part, index) =>
              (part.timeline ?? []).map((segment) => {
                  const {
                      timestamp_correction: _correction,
                      chunk_index: _chunk,
                      speaker_id,
                      ...rest
                  } = segment;
                  return {
                      ...rest,
                      start_ms: segment.start_ms + offsetsMs[index],
                      end_ms: segment.end_ms + offsetsMs[index],
                      ...(speaker_id !== undefined && {
                          speaker_id: `p${index + 1}:${speaker_id}`,
                      }),
                  };
              }),
          )
        : null;

    return { text, timeline };
}
