import { transcriptExportFilename } from "@/lib/transcript/export";

export type SummaryExportFormat = "md" | "txt";

export interface SummaryExportInput {
    /** The recording name, used for the heading and the file name. */
    title: string;
    summary: string;
    keyPoints?: string[] | null;
    actionItems?: string[] | null;
    /** Template name shown in the header line. */
    templateName?: string | null;
    /** Output language name shown in the header line. */
    languageName?: string | null;
    model?: string | null;
}

export interface SummaryExportFile {
    filename: string;
    content: string;
    mimeType: string;
}

const MIME_TYPES: Record<SummaryExportFormat, string> = {
    md: "text/markdown",
    txt: "text/plain",
};

const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}/;

/**
 * Plain text from a Markdown summary. Headings, emphasis, code spans, and
 * links lose their markup. Table rows keep their cells, joined with " | ".
 */
export function markdownToPlainText(markdown: string): string {
    const lines = markdown.split("\n").flatMap((line) => {
        if (TABLE_SEPARATOR.test(line)) return [];
        if (line.trim().startsWith("|")) {
            return [
                line
                    .trim()
                    .replace(/^\|/, "")
                    .replace(/\|$/, "")
                    .split("|")
                    .map((cell) => cell.trim())
                    .join(" | "),
            ];
        }
        return [
            line
                .replace(/^#{1,6}\s+/, "")
                .replace(/\*\*(.+?)\*\*/g, "$1")
                .replace(/__(.+?)__/g, "$1")
                .replace(/(?<![\w*])\*(?=\S)(.+?)(?<=\S)\*(?![\w*])/g, "$1")
                .replace(/`([^`]+)`/g, "$1")
                .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1 ($2)"),
        ];
    });
    return lines
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

/** A downloadable summary as Markdown or plain text. */
export function buildSummaryExport(
    format: SummaryExportFormat,
    input: SummaryExportInput,
): SummaryExportFile {
    const heading = input.title.trim() || "Summary";
    const meta = [input.templateName, input.languageName, input.model]
        .filter(Boolean)
        .join(" · ");
    const keyPoints = input.keyPoints ?? [];
    const actionItems = input.actionItems ?? [];

    const lines: string[] = [];
    if (format === "md") {
        lines.push(`# ${heading}`, "");
        if (meta) lines.push(`*${meta}*`, "");
        lines.push(input.summary.trim(), "");
        if (keyPoints.length) {
            lines.push(
                "## Key Points",
                "",
                ...keyPoints.map((p) => `- ${p}`),
                "",
            );
        }
        if (actionItems.length) {
            lines.push(
                "## Action Items",
                "",
                ...actionItems.map((a) => `- ${a}`),
                "",
            );
        }
    } else {
        lines.push(heading, "");
        if (meta) lines.push(meta, "");
        lines.push(markdownToPlainText(input.summary), "");
        if (keyPoints.length) {
            lines.push("Key Points", ...keyPoints.map((p) => `- ${p}`), "");
        }
        if (actionItems.length) {
            lines.push("Action Items", ...actionItems.map((a) => `- ${a}`), "");
        }
    }

    return {
        filename: transcriptExportFilename(`${heading} summary`, format),
        content: `${lines.join("\n").trimEnd()}\n`,
        mimeType: MIME_TYPES[format],
    };
}
