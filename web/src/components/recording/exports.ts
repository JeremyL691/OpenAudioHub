import type { TimelineSegment, TranscriptRecord } from "./types";
import { toast } from "sonner";

/** hh:mm:ss for transcript timecodes. */
export function timecode(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

function stampParts(ms: number): { h: string; m: string; s: string; ms: string } {
    const safe = Math.max(0, Math.round(ms));
    return {
        h: String(Math.floor(safe / 3600000)).padStart(2, "0"),
        m: String(Math.floor((safe % 3600000) / 60000)).padStart(2, "0"),
        s: String(Math.floor((safe % 60000) / 1000)).padStart(2, "0"),
        ms: String(safe % 1000).padStart(3, "0"),
    };
}

/** SubRip file body. Segments need timings. */
export function buildSrt(segments: TimelineSegment[]): string {
    return segments
        .map((seg, i) => {
            const a = stampParts(seg.start_ms);
            const b = stampParts(seg.end_ms);
            return `${i + 1}\n${a.h}:${a.m}:${a.s},${a.ms} --> ${b.h}:${b.m}:${b.s},${b.ms}\n${seg.text.trim()}\n`;
        })
        .join("\n");
}

/** WebVTT file body. Segments need timings. */
export function buildVtt(segments: TimelineSegment[]): string {
    const cues = segments.map((seg) => {
        const a = stampParts(seg.start_ms);
        const b = stampParts(seg.end_ms);
        return `${a.h}:${a.m}:${a.s}.${a.ms} --> ${b.h}:${b.m}:${b.s}.${b.ms}\n${seg.text.trim()}\n`;
    });
    return `WEBVTT\n\n${cues.join("\n")}`;
}

export function buildTranscriptJson(t: TranscriptRecord): string {
    return `${JSON.stringify(
        {
            text: t.text,
            language: t.detectedLanguage,
            provider: t.provider,
            model: t.model,
            source: t.source,
            segments: t.timeline ?? [],
        },
        null,
        2,
    )}\n`;
}

/** A file name safe on macOS and Windows, from a recording title. */
export function safeFileName(title: string, fallback = "recording"): string {
    const cleaned = title
        .replace(/[/\\:*?"<>|]/g, "-")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120);
    return cleaned || fallback;
}

/** Saves text through the desktop save dialog or a temporary browser object URL. Resolves false when the desktop save failed. */
export async function downloadText(fileName: string, mime: string, content: string): Promise<boolean> {
    const desktop = (window as unknown as {
        __openaudiohubDesktop?: { saveTextFile?: (name: string, text: string) => Promise<boolean> };
    }).__openaudiohubDesktop;
    if (desktop?.saveTextFile) {
        try {
            return await desktop.saveTextFile(fileName, content);
        } catch {
            toast.error("Could not save the export");
            return false;
        }
    }
    const url = URL.createObjectURL(new Blob([content], { type: `${mime};charset=utf-8` }));
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
}

export interface SummaryExportInput {
    title: string;
    summary: string;
    keyPoints: string[];
    actionItems: string[];
    meta: string[];
}

/** Markdown export of a summary, per spec/ai.md "Summary export". */
export function summaryMarkdown(input: SummaryExportInput): string {
    const parts = [`# ${input.title}`];
    if (input.meta.length) parts.push(`*${input.meta.join(" · ")}*`);
    parts.push(input.summary.trim());
    if (input.keyPoints.length) parts.push(`## Key Points\n\n${input.keyPoints.map((p) => `- ${p}`).join("\n")}`);
    if (input.actionItems.length) parts.push(`## Action Items\n\n${input.actionItems.map((p) => `- ${p}`).join("\n")}`);
    return `${parts.join("\n\n")}\n`;
}

/** Plain text export of a summary: Markdown markup removed, lists as dashes. */
export function summaryPlain(input: SummaryExportInput): string {
    const body = input.summary
        .split("\n")
        .filter((line) => !/^\s*\|?\s*:?-{3,}/.test(line))
        .map((line) =>
            line
                .replace(/^#{1,6}\s*/, "")
                .replace(/\*\*(.+?)\*\*/g, "$1")
                .replace(/\*(.+?)\*/g, "$1")
                .replace(/`(.+?)`/g, "$1")
                .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
                .replace(/^\s*\|(.+)\|\s*$/, (_m, cells: string) => cells.split("|").map((c) => c.trim()).join(" | "))
                .replace(/^\s*[*+]\s+/, "- "),
        )
        .join("\n")
        .trim();
    const lines = [input.title, input.meta.join(" · "), body];
    if (input.keyPoints.length) lines.push("Key Points", ...input.keyPoints.map((p) => `- ${p}`));
    if (input.actionItems.length) lines.push("Action Items", ...input.actionItems.map((p) => `- ${p}`));
    return `${lines.filter((l) => l !== "").join("\n\n")}\n`;
}
