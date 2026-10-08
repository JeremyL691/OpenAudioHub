"use client";

import {
    ChevronDown,
    ChevronUp,
    ListChecks,
    Loader2,
    RefreshCw,
    Sparkles,
    Trash2,
} from "lucide-react";
import { PromptSelect } from "@/components/recording/ai/prompt-select";
import { RichMarkdown } from "@/components/recordings/rich-content";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { useTranscriptionSummary } from "@/hooks/use-transcription-summary";

type SummaryState = ReturnType<typeof useTranscriptionSummary>;

/** The summary card: generate or regenerate, expand, key points, action items, delete. */
export function SummaryPanel({ summary }: { summary: SummaryState }) {
    const {
        summaryData,
        isSummarizing,
        summaryExpanded,
        setSummaryExpanded,
        summaryPreset,
        setSummaryPreset,
        summaryPromptOptions,
        handleSummarize,
        handleDeleteSummary,
    } = summary;

    return (
        <Card data-testid="summary-panel">
            <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle className="flex items-center gap-2">
                        <ListChecks className="size-5" />
                        Summary
                    </CardTitle>
                    <div className="flex flex-wrap items-center gap-2">
                        {!isSummarizing && (
                            <PromptSelect
                                value={summaryPreset}
                                options={summaryPromptOptions}
                                onChange={setSummaryPreset}
                            />
                        )}
                        <Button
                            data-testid="summary-generate"
                            onClick={handleSummarize}
                            size="sm"
                            variant={summaryData ? "outline" : "default"}
                            disabled={isSummarizing}
                        >
                            {isSummarizing ? (
                                <>
                                    <Loader2 className="size-4 mr-2 animate-spin" />
                                    Generating…
                                </>
                            ) : summaryData ? (
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
            </CardHeader>
            <CardContent>
                {isSummarizing ? (
                    <div className="flex flex-col items-center justify-center py-8">
                        <Loader2 className="size-8 animate-spin text-primary mb-4" />
                        <p className="text-sm text-muted-foreground">
                            Generating summary…
                        </p>
                    </div>
                ) : summaryData?.summary ? (
                    <div className="space-y-4">
                        <button
                            type="button"
                            onClick={() => setSummaryExpanded(!summaryExpanded)}
                            className="flex items-center gap-1 text-sm font-medium hover:text-primary transition-colors"
                        >
                            {summaryExpanded ? (
                                <ChevronUp className="size-4" />
                            ) : (
                                <ChevronDown className="size-4" />
                            )}
                            {summaryExpanded ? "Collapse" : "Expand summary"}
                        </button>

                        {summaryExpanded && (
                            <div className="space-y-4">
                                {/* Summary text */}
                                <div
                                    data-testid="summary-content"
                                    className="bg-muted rounded-lg p-4 text-sm"
                                >
                                    <RichMarkdown
                                        content={summaryData.summary}
                                    />
                                </div>

                                {/* Key points */}
                                {summaryData.keyPoints &&
                                    summaryData.keyPoints.length > 0 && (
                                        <div>
                                            <h4 className="text-sm font-medium mb-2">
                                                Key Points
                                            </h4>
                                            <ul className="space-y-1">
                                                {summaryData.keyPoints.map(
                                                    (point) => {
                                                        const key = `kp-${point.slice(0, 32)}`;
                                                        return (
                                                            <li
                                                                key={key}
                                                                className="text-sm text-muted-foreground flex items-start gap-2"
                                                            >
                                                                <span className="text-primary mt-1.5 size-1.5 rounded-full bg-primary shrink-0" />
                                                                {point}
                                                            </li>
                                                        );
                                                    },
                                                )}
                                            </ul>
                                        </div>
                                    )}

                                {/* Action items */}
                                {summaryData.actionItems &&
                                    summaryData.actionItems.length > 0 && (
                                        <div>
                                            <h4 className="text-sm font-medium mb-2">
                                                Action Items
                                            </h4>
                                            <ul className="space-y-1">
                                                {summaryData.actionItems.map(
                                                    (item) => {
                                                        const key = `ai-${item.slice(0, 32)}`;
                                                        return (
                                                            <li
                                                                key={key}
                                                                className="text-sm text-muted-foreground flex items-start gap-2"
                                                            >
                                                                <ListChecks className="size-3.5 mt-0.5 text-primary shrink-0" />
                                                                {item}
                                                            </li>
                                                        );
                                                    },
                                                )}
                                            </ul>
                                        </div>
                                    )}

                                {/* Meta + Delete */}
                                <div className="flex items-center justify-between pt-2 border-t">
                                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                                        {summaryData.provider && (
                                            <span className="px-2 py-0.5 rounded bg-muted">
                                                {summaryData.provider}
                                            </span>
                                        )}
                                        {summaryData.model && (
                                            <span className="px-2 py-0.5 rounded bg-muted font-mono">
                                                {summaryData.model}
                                            </span>
                                        )}
                                    </div>
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
                        )}
                    </div>
                ) : (
                    <div className="flex flex-col items-center justify-center py-8 text-center">
                        <ListChecks className="size-10 text-muted-foreground mb-3" />
                        <p className="text-sm text-muted-foreground">
                            No summary yet. Click &quot;Summarize&quot; to
                            generate one.
                        </p>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
