import type { TimelineSegment } from "@/hooks/use-pipeline-status";

export type TranscriptExportFormat = "txt" | "srt" | "vtt" | "json";

export const TRANSCRIPT_EXPORT_FORMATS: {
    format: TranscriptExportFormat;
    label: string;
}[] = [
    { format: "txt", label: "TXT" },
    { format: "srt", label: "SRT" },
    { format: "vtt", label: "VTT" },
    { format: "json", label: "JSON" },
];

export interface TranscriptExportInput {
    /** The recording's name, written into the JSON title field. */
    title: string;
    language?: string;
    text: string;
    timeline: TimelineSegment[] | null | undefined;
}

export interface TranscriptExportFile {
    content: string;
    mimeType: string;
    extension: string;
}

const MIME_TYPES: Record<TranscriptExportFormat, string> = {
    txt: "text/plain",
    srt: "application/x-subrip",
    vtt: "text/vtt",
    json: "application/json",
};

/** SRT and VTT need timestamps, so they are unavailable for an untimed transcript. */
export function isTranscriptExportAvailable(
    format: TranscriptExportFormat,
    timeline: TimelineSegment[] | null | undefined,
): boolean {
    if (format === "srt" || format === "vtt") return Boolean(timeline?.length);
    return true;
}

function pad(value: number, width: number): string {
    return String(value).padStart(width, "0");
}

/** SRT time: HH:MM:SS,mmm. */
export function formatSrtTime(ms: number): string {
    const total = Math.max(0, Math.floor(ms));
    const hours = Math.floor(total / 3_600_000);
    const minutes = Math.floor((total % 3_600_000) / 60_000);
    const seconds = Math.floor((total % 60_000) / 1000);
    const millis = total % 1000;
    return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)},${pad(millis, 3)}`;
}

/** WebVTT time: HH:MM:SS.mmm. */
export function formatVttTime(ms: number): string {
    return formatSrtTime(ms).replace(",", ".");
}

export function toPlainText(text: string): string {
    return `${text.trim()}\n`;
}

export function toSrt(segments: TimelineSegment[]): string {
    return segments
        .map(
            (segment, index) =>
                `${index + 1}\n${formatSrtTime(segment.start_ms)} --> ${formatSrtTime(segment.end_ms)}\n${segment.text.trim()}\n`,
        )
        .join("\n");
}

export function toVtt(segments: TimelineSegment[]): string {
    const cues = segments.map(
        (segment) =>
            `${formatVttTime(segment.start_ms)} --> ${formatVttTime(segment.end_ms)}\n${segment.text.trim()}\n`,
    );
    return ["WEBVTT\n", ...cues].join("\n");
}

export function toJsonDocument({
    title,
    language,
    text,
    timeline,
}: TranscriptExportInput): string {
    const document = {
        title,
        language: language ?? null,
        text,
        segments: timeline ?? [],
    };
    return `${JSON.stringify(document, null, 2)}\n`;
}

/** Returns null when the format needs timestamps the transcript does not have. */
export function buildTranscriptExport(
    format: TranscriptExportFormat,
    input: TranscriptExportInput,
): TranscriptExportFile | null {
    if (!isTranscriptExportAvailable(format, input.timeline)) return null;
    const timeline = input.timeline ?? [];
    const content = {
        txt: () => toPlainText(input.text),
        srt: () => toSrt(timeline),
        vtt: () => toVtt(timeline),
        json: () => toJsonDocument(input),
    }[format]();
    return { content, mimeType: MIME_TYPES[format], extension: format };
}

/** A download name from the title, with characters unsafe in file names replaced. */
export function transcriptExportFilename(
    title: string,
    extension: string,
): string {
    const base = title
        .replace(/[\\/:*?"<>|]+/g, "-")
        .replace(/\s+/g, " ")
        .trim();
    return `${base || "transcript"}.${extension}`;
}
