"use client";

import type { TranscriptOption } from "@/components/recording/transcript/types";

/** The label for a transcript source. Plaud and mixed sources keep their names. */
export function transcriptSourceLabel(source: string): string {
    if (source === "plaud") return "Plaud";
    if (source === "mixed") return "Mix";
    return "Your provider";
}

interface SourceSwitcherProps {
    transcripts: TranscriptOption[];
    activeSource: string;
    onSelect: (source: string) => void;
}

/** Switches between transcript sources. Hidden when there is only one. */
export function SourceSwitcher({
    transcripts,
    activeSource,
    onSelect,
}: SourceSwitcherProps) {
    if (transcripts.length <= 1) return null;
    return (
        <div
            data-testid="source-switcher"
            className="flex items-center gap-2 border-b pb-2"
        >
            {transcripts.map((t) => (
                <button
                    key={t.source}
                    type="button"
                    onClick={() => onSelect(t.source)}
                    className={`px-3 py-1 text-xs rounded-md transition-colors ${
                        t.source === activeSource
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted text-muted-foreground hover:text-foreground"
                    }`}
                >
                    {transcriptSourceLabel(t.source)}
                </button>
            ))}
        </div>
    );
}
