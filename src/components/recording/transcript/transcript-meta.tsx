"use client";

import { Languages } from "lucide-react";
import { transcriptSourceLabel } from "@/components/recording/transcript/source-switcher";
import type { TranscriptOption } from "@/components/recording/transcript/types";

/** Source, language, word count, and character count for the shown transcript. */
export function TranscriptMeta({
    transcript,
}: {
    transcript: TranscriptOption;
}) {
    return (
        <div className="flex items-center gap-4 text-xs text-muted-foreground pt-2 border-t">
            <span className="px-2 py-0.5 rounded bg-muted font-medium">
                {transcriptSourceLabel(transcript.source)}
            </span>
            {transcript.language && (
                <div className="flex items-center gap-1">
                    <Languages className="size-3" />
                    <span>Language: {transcript.language}</span>
                </div>
            )}
            <div>
                {transcript.text.trim()
                    ? transcript.text.trim().split(/\s+/).length
                    : 0}{" "}
                words
            </div>
            <div>{transcript.text.length} characters</div>
        </div>
    );
}
