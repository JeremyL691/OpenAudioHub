"use client";

import {
    Copy,
    Download,
    ListChecks,
    Loader2,
    RefreshCw,
    Sparkles,
    Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { PromptSelect } from "@/components/recording/ai/prompt-select";
import { RichMarkdown } from "@/components/recordings/rich-content";
import { Button } from "@/components/ui/button";
import type { useTranscriptionSummary } from "@/hooks/use-transcription-summary";
import { AI_OUTPUT_LANGUAGES } from "@/lib/ai/summary-presets";
import { downloadText } from "@/lib/download-text";
import {
    buildSummaryExport,
    type SummaryExportFormat,
} from "@/lib/summary/export";

type SummaryState = ReturnType<typeof useTranscriptionSummary>;

const LANGUAGE_OPTIONS = AI_OUTPUT_LANGUAGES.map((l) => ({
    id: l.code,
    name: l.label,
}));

/**
 * The summary card: generate or regenerate with a template and language,
 * collapse, key points, action items, copy or download, and delete.
 */
export function SummaryPanel({
    summary,
    title,
}: {
    summary: SummaryState;
    /** The recording name, used in exports. */
    title: string;
}) {
    const {
        summaryData,
        isSummarizing,
        summaryPreset,
        setSummaryPreset,
        summaryPromptOptions,
        summaryLanguage,
        setSummaryLanguage,
        handleSummarize,
        handleDeleteSummary,
    } = summary;

    const hasSummary = Boolean(summaryData?.summary);

    const templateName = summaryData?.promptId
        ? (summaryPromptOptions.find((p) => p.id === summaryData.promptId)
              ?.name ?? null)
        : null;
    const languageName = summaryData?.language
        ? (AI_OUTPUT_LANGUAGES.find((l) => l.code === summaryData.language)
              ?.label ?? null)
        : null;

    const exportSummary = (format: SummaryExportFormat) => {
        if (!summaryData?.summary) return;
        const file = buildSummaryExport(format, {
            title,
            summary: summaryData.summary,
            keyPoints: summaryData.keyPoints,
            actionItems: summaryData.actionItems,
            templateName,
            languageName,
            model: summaryData.model,
        });
        downloadText(file.filename, file.content, file.mimeType);
    };

    const copySummary = async () => {
        if (!summaryData?.summary) return;
        try {
            await navigator.clipboard.writeText(summaryData.summary);
            toast.success("Summary copied");
        } catch {
            toast.error("Couldn't copy the summary");
        }
    };

    return (
        <section
            data-testid="summary-panel"
            className="rounded-2xl bg-card p-5 shadow-card"
        >
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-[17px] font-semibold">Summary</h2>
                <div className="flex flex-wrap items-center gap-2">
                    {!isSummarizing && (
                        <>
                            <PromptSelect
                                label="Summary language"
                                value={summaryLanguage}
                                options={LANGUAGE_OPTIONS}
                                onChange={setSummaryLanguage}
                            />
                            <PromptSelect
                                value={summaryPreset}
                                options={summaryPromptOptions}
                                onChange={setSummaryPreset}
                            />
                        </>
                    )}
                    <Button
                        data-testid="summary-generate"
                        onClick={() => void handleSummarize()}
                        size="sm"
                        className="h-10 sm:h-8"
                        variant={hasSummary ? "secondary" : "default"}
                        disabled={isSummarizing}
                    >
                        {isSummarizing ? (
                            <>
                                <Loader2 className="size-4 mr-2 animate-spin" />
                                Generating…
                            </>
                        ) : hasSummary ? (
                            <>
                                <RefreshCw className="size-4 mr-2" />
                                Re-generate
                            </>
                        ) : (
                            <>
                                <Sparkles className="size-4 mr-2" />
                                Summarize
                            </>
                        )}
                    </Button>
                </div>
            </div>
            <div className="mt-4">
                {isSummarizing ? (
                    <div className="flex flex-col items-center justify-center py-6">
                        <Loader2 className="size-8 animate-spin text-primary mb-4" />
                        <p className="text-sm text-muted-foreground">
                            Generating summary…
                        </p>
                    </div>
                ) : summaryData?.summary ? (
                    <div className="space-y-4">
                        <div
                            data-testid="summary-content"
                            className="text-sm leading-6"
                        >
                            <RichMarkdown content={summaryData.summary} />
                        </div>

                        {summaryData.keyPoints &&
                            summaryData.keyPoints.length > 0 && (
                                <div>
                                    <h4 className="mb-2 text-[13px] font-semibold">
                                        Key Points
                                    </h4>
                                    <ul className="space-y-1">
                                        {summaryData.keyPoints.map((point) => {
                                            const key = `kp-${point.slice(0, 32)}`;
                                            return (
                                                <li
                                                    key={key}
                                                    className="flex items-start gap-2 text-sm leading-6"
                                                >
                                                    <span className="mt-2.5 size-1.5 shrink-0 rounded-full bg-primary" />
                                                    {point}
                                                </li>
                                            );
                                        })}
                                    </ul>
                                </div>
                            )}

                        {summaryData.actionItems &&
                            summaryData.actionItems.length > 0 && (
                                <div>
                                    <h4 className="mb-2 text-[13px] font-semibold">
                                        Action Items
                                    </h4>
                                    <ul className="space-y-1">
                                        {summaryData.actionItems.map((item) => {
                                            const key = `ai-${item.slice(0, 32)}`;
                                            return (
                                                <li
                                                    key={key}
                                                    className="flex items-start gap-2 text-sm leading-6"
                                                >
                                                    <ListChecks className="mt-1 size-3.5 shrink-0 text-primary" />
                                                    {item}
                                                </li>
                                            );
                                        })}
                                    </ul>
                                </div>
                            )}

                        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
                            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                                {templateName && (
                                    <span className="rounded bg-muted px-2 py-0.5">
                                        {templateName}
                                    </span>
                                )}
                                {languageName && (
                                    <span className="rounded bg-muted px-2 py-0.5">
                                        {languageName}
                                    </span>
                                )}
                                {summaryData.provider && (
                                    <span className="rounded bg-muted px-2 py-0.5">
                                        {summaryData.provider}
                                    </span>
                                )}
                                {summaryData.model && (
                                    <span className="rounded bg-muted px-2 py-0.5 font-mono">
                                        {summaryData.model}
                                    </span>
                                )}
                            </div>
                            <div className="flex flex-wrap items-center gap-1">
                                <Button
                                    onClick={copySummary}
                                    size="sm"
                                    variant="ghost"
                                >
                                    <Copy className="size-4 mr-1" />
                                    Copy
                                </Button>
                                <Button
                                    onClick={() => exportSummary("md")}
                                    size="sm"
                                    variant="ghost"
                                    aria-label="Download summary as Markdown"
                                >
                                    <Download className="size-4 mr-1" />
                                    Markdown
                                </Button>
                                <Button
                                    onClick={() => exportSummary("txt")}
                                    size="sm"
                                    variant="ghost"
                                    aria-label="Download summary as TXT"
                                >
                                    <Download className="size-4 mr-1" />
                                    TXT
                                </Button>
                                <Button
                                    onClick={handleDeleteSummary}
                                    size="sm"
                                    variant="ghost"
                                    className="text-destructive hover:text-destructive"
                                >
                                    <Trash2 className="size-4 mr-1" />
                                    Delete
                                </Button>
                            </div>
                        </div>
                    </div>
                ) : (
                    <div className="flex flex-col items-center justify-center py-6 text-center">
                        <ListChecks className="size-10 text-muted-foreground mb-3" />
                        <p className="text-sm text-muted-foreground">
                            No summary yet. Click &quot;Summarize&quot; to
                            generate one.
                        </p>
                    </div>
                )}
            </div>
        </section>
    );
}
