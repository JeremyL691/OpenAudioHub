"use client";

import { SummaryPanel } from "@/components/recording/ai/summary-panel";
import { TranscriptCard } from "@/components/recording/transcript/transcript-card";
import type { TranscriptOption } from "@/components/recording/transcript/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRecordingTranscript } from "@/hooks/use-recording-transcript";
import type { Recording } from "@/types/recording";

export type { TranscriptOption } from "@/components/recording/transcript/types";

interface Transcription {
    text?: string;
    language?: string;
}

interface TranscriptionPanelProps {
    recording: Recording;
    /** Back-compat single transcript. Used only when `transcripts` is absent. */
    transcription?: Transcription;
    /** All transcripts for the recording, one per source, primary first. When
     * more than one is present a source switcher is shown. */
    transcripts?: TranscriptOption[];
    isTranscribing: boolean;
    onTranscribe: () => void;
    /** Refresh handler called after a browser-side transcription completes. */
    onTranscribeComplete?: () => void;
    onSeekTimestamp?: (milliseconds: number) => void;
    playbackTimeMs?: number;
}

/**
 * The library preview's transcript and summary for one recording, one at a
 * time behind a Transcript | Summary switch.
 * The state comes from useRecordingTranscript and the cards from
 * TranscriptCard (preview variant) and SummaryPanel.
 */
export function TranscriptionPanel({
    recording,
    transcription,
    transcripts,
    isTranscribing,
    onTranscribe,
    onTranscribeComplete,
    onSeekTimestamp,
    playbackTimeMs,
}: TranscriptionPanelProps) {
    const transcript = useRecordingTranscript({
        recording,
        transcription,
        transcripts,
        isTranscribing,
        onTranscribeComplete,
    });

    return (
        <Tabs defaultValue="transcript" className="gap-4">
            <TabsList>
                <TabsTrigger value="transcript">Transcript</TabsTrigger>
                <TabsTrigger value="summary">Summary</TabsTrigger>
            </TabsList>
            <TabsContent value="transcript">
                <TranscriptCard
                    variant="preview"
                    recording={recording}
                    transcript={transcript}
                    isTranscribing={isTranscribing}
                    onTranscribe={onTranscribe}
                    onTranscribeComplete={onTranscribeComplete}
                    playbackTimeMs={playbackTimeMs}
                    onSeekTimestamp={onSeekTimestamp}
                />
            </TabsContent>
            <TabsContent value="summary">
                {transcript.activeTranscript?.text ? (
                    <SummaryPanel
                        summary={transcript.summary}
                        title={recording.filename}
                    />
                ) : (
                    <Card>
                        <CardHeader>
                            <CardTitle>Summary</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <p className="text-sm text-muted-foreground">
                                A summary is available once the recording has a
                                transcript.
                            </p>
                        </CardContent>
                    </Card>
                )}
            </TabsContent>
        </Tabs>
    );
}
