"use client";

import {
    Download,
    MoreHorizontal,
    RefreshCw,
    Sparkles,
    Star,
    Trash2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { TimelineSegment } from "@/hooks/use-pipeline-status";
import { downloadText } from "@/lib/download-text";
import { recordingAudioDownloadPath } from "@/lib/recordings/filename";
import { setRecordingStarred } from "@/lib/recordings/star";
import {
    buildTranscriptExport,
    isTranscriptExportAvailable,
    TRANSCRIPT_EXPORT_FORMATS,
    type TranscriptExportFormat,
    transcriptExportFilename,
} from "@/lib/transcript/export";

interface RecordingActionsMenuProps {
    recordingId: string;
    title: string;
    /** The transcript the user is reading. Null when there is none yet. */
    transcript: { text: string; language?: string } | null;
    timeline: TimelineSegment[] | null | undefined;
    /** A transcription or pipeline job is running. */
    busy: boolean;
    /** Whether the recording is starred. Defaults to unstarred. */
    starred?: boolean;
    onTranscribe: () => void;
    onDelete: () => void;
}

/**
 * Download, export, transcribe, and delete for one recording. Exports are built
 * in the browser from the transcript already on the page.
 */
export function RecordingActionsMenu({
    recordingId,
    title,
    transcript,
    timeline,
    busy,
    starred = false,
    onTranscribe,
    onDelete,
}: RecordingActionsMenuProps) {
    const router = useRouter();
    const hasTranscript = Boolean(transcript?.text);

    const toggleStar = async () => {
        try {
            await setRecordingStarred(recordingId, !starred);
            router.refresh();
        } catch {
            toast.error("Could not update the star");
        }
    };

    const exportAs = (format: TranscriptExportFormat) => {
        if (!transcript) return;
        const file = buildTranscriptExport(format, {
            title,
            language: transcript.language,
            text: transcript.text,
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
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    variant="outline"
                    size="icon"
                    aria-label="Recording actions"
                    title="Recording actions"
                    className="size-10 shrink-0 text-muted-foreground shadow-none sm:size-8 hover:text-foreground"
                >
                    <MoreHorizontal className="size-4" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem asChild>
                    <a
                        href={recordingAudioDownloadPath(recordingId)}
                        download
                        rel="nofollow noreferrer"
                    >
                        <Download className="size-4" />
                        Download audio
                    </a>
                </DropdownMenuItem>
                <DropdownMenuItem
                    data-testid="recording-star-toggle"
                    onSelect={() => void toggleStar()}
                >
                    <Star
                        className={starred ? "size-4 fill-current" : "size-4"}
                    />
                    {starred ? "Unstar" : "Star"}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {TRANSCRIPT_EXPORT_FORMATS.map(({ format, label }) => (
                    <DropdownMenuItem
                        key={format}
                        disabled={
                            !hasTranscript ||
                            !isTranscriptExportAvailable(format, timeline)
                        }
                        onSelect={() => exportAs(format)}
                    >
                        <Download className="size-4" />
                        Export {label}
                    </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled={busy} onSelect={onTranscribe}>
                    {hasTranscript ? (
                        <RefreshCw className="size-4" />
                    ) : (
                        <Sparkles className="size-4" />
                    )}
                    {hasTranscript ? "Re-transcribe" : "Transcribe"}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                    <Trash2 className="size-4" />
                    Delete recording
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
