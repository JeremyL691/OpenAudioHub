"use client";

import { Download, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { TimelineSegment } from "@/hooks/use-pipeline-status";
import { downloadText } from "@/lib/download-text";
import {
    buildTranscriptExport,
    transcriptExportFilename,
} from "@/lib/transcript/export";

interface TranscriptToolbarProps {
    /** The recording name, used for the download file name. */
    title: string;
    text: string;
    language?: string;
    timeline: TimelineSegment[] | null | undefined;
    /** Delete is blocked while a transcription or pipeline job is running. */
    deleteDisabled: boolean;
    onDelete: () => void;
}

/** Download the transcript as TXT or JSON, or delete it. */
export function TranscriptToolbar({
    title,
    text,
    language,
    timeline,
    deleteDisabled,
    onDelete,
}: TranscriptToolbarProps) {
    const exportAs = (format: "txt" | "json") => {
        const file = buildTranscriptExport(format, {
            title,
            language,
            text,
            timeline,
        });
        if (!file) return;
        downloadText(
            transcriptExportFilename(title, file.extension),
            file.content,
            file.mimeType,
        );
    };

    return (
        <div
            data-testid="transcript-toolbar"
            className="flex flex-wrap items-center justify-end gap-2"
        >
            <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label="Download transcript as TXT"
                onClick={() => exportAs("txt")}
            >
                <Download className="size-4 mr-2" />
                TXT
            </Button>
            <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label="Download transcript as JSON"
                onClick={() => exportAs("json")}
            >
                <Download className="size-4 mr-2" />
                JSON
            </Button>
            <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                disabled={deleteDisabled}
                onClick={onDelete}
            >
                <Trash2 className="size-4 mr-2" />
                Delete
            </Button>
        </div>
    );
}
