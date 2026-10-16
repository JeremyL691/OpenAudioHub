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
            className="inline-flex items-center gap-0.5 self-start rounded-lg bg-secondary p-0.5"
        >
            {transcripts.map((t) => {
                const active = t.source === activeSource;
                return (
                    <button
                        key={t.source}
                        type="button"
                        onClick={() => onSelect(t.source)}
                        className={`h-10 rounded-md px-3 text-[13px] transition-colors sm:h-7 ${
                            active
                                ? "bg-background font-medium text-foreground shadow-sm dark:bg-accent"
                                : "text-muted-foreground hover:text-foreground"
                        }`}
                    >
                        {transcriptSourceLabel(t.source)}
                    </button>
                );
            })}
        </div>
    );
}
