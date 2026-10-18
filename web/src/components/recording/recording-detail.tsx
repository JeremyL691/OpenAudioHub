import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PlayerCard } from "@/components/player/player-card";
import { usePlayer } from "@/components/player/player-context";
import { api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { RECORDINGS_CHANGED } from "@/lib/recordings";
import { DetailsCard } from "./details-card";
import { useRecordingDetail, usePipelineWatch } from "./data";
import { RecordingHeader } from "./recording-header";
import { SummaryPanel } from "./summary-panel";
import { TranscribeDialog, TranscriptCard } from "./transcript-card";
import type { TranscriptRecord } from "./types";

export interface RecordingDetailProps {
    id: string;
    /** "page" is /recordings/:id (a full view). "pane" is the detail pane beside the library list. */
    variant: "page" | "pane";
}

type Tab = "transcript" | "summary" | "details";

/** The recording view: header, player, transcript, summary and details. */
export function RecordingDetail(props: RecordingDetailProps) {
    // Keyed by id so that per-recording state (waveform attempts, tabs) starts fresh for each recording.
    return <RecordingDetailView key={props.id} {...props} />;
}

function RecordingDetailView({ id, variant }: RecordingDetailProps) {
    const navigate = useNavigate();
    const detail = useRecordingDetail(id);
    const { data, reload } = detail;
    // A settled job changes the row badge in the library list; announce it.
    const pipe = usePipelineWatch(id, () => {
        void reload();
        window.dispatchEvent(new Event(RECORDINGS_CHANGED));
    });
    const player = usePlayer();
    const setPlayerOnScreen = player?.setPlayerOnScreen;
    const [transcribing, setTranscribing] = useState(false);
    const [transcribeOpen, setTranscribeOpen] = useState(false);
    const [source, setSource] = useState<string | null>(null);
    const [tab, setTab] = useState<Tab>("transcript");
    const [playerEl, setPlayerEl] = useState<HTMLDivElement | null>(null);
    const page = variant === "page";

    // The mini player shows while the full player is scrolled out of view (page variant only).
    useEffect(() => {
        if (!page || !setPlayerOnScreen || !playerEl) return;
        const observer = new IntersectionObserver(([entry]) => setPlayerOnScreen(entry.isIntersecting));
        observer.observe(playerEl);
        return () => {
            observer.disconnect();
            setPlayerOnScreen(true);
        };
    }, [page, setPlayerOnScreen, playerEl]);

    if (detail.status === "loading") {
        return (
            <div className="grid place-items-center p-10">
                <Spinner label="Loading recording" />
            </div>
        );
    }

    if (detail.status === "missing") {
        return (
            <EmptyState
                title="Recording not found"
                description="It may have been deleted, or the link is wrong."
                action={
                    <Button variant="secondary" onClick={() => navigate("/recordings")}>
                        Back to recordings
                    </Button>
                }
            />
        );
    }

    if (!data) {
        return (
            <EmptyState
                title="Could not load this recording"
                description={detail.message ?? "Try again in a moment."}
                action={
                    <Button variant="secondary" onClick={() => void reload()}>
                        Try again
                    </Button>
                }
            />
        );
    }

    const { recording } = data;
    const transcripts: TranscriptRecord[] = data.transcriptions ?? (data.transcription ? [data.transcription] : []);
    const transcript = transcripts.find((t) => t.source === source) ?? transcripts[0] ?? null;
    const busy = transcribing || pipe.active;

    const runTranscribe = async (body: { providerId?: string; model?: string }) => {
        setTranscribeOpen(false);
        setTranscribing(true);
        try {
            const answer = await api<{ jobId?: string }>(`/api/recordings/${encodeURIComponent(id)}/transcribe`, { method: "POST", json: body });
            if (answer && typeof answer === "object" && "jobId" in answer) {
                pipe.queue();
            } else {
                toast.success("Transcription complete");
            }
            await reload();
            // The list row shows "Transcribing" (or the new result) right away.
            window.dispatchEvent(new Event(RECORDINGS_CHANGED));
        } catch (err) {
            toast.error(errorMessage(err, "Transcription failed"));
        } finally {
            setTranscribing(false);
        }
    };

    const sendPipelineAction = async (action: "cancel" | "retry") => {
        try {
            await api(`/api/recordings/${encodeURIComponent(id)}/audio-pipeline`, { method: "POST", json: { action } });
            if (action === "retry") pipe.queue();
            else await pipe.refresh();
        } catch (err) {
            toast.error(errorMessage(err, action === "retry" ? "Could not retry" : "Could not cancel"));
        }
    };

    return (
        <div
            className={cn(
                "flex min-w-0 flex-col gap-6",
                page ? "px-4 py-6 lg:h-[calc(100svh-3.25rem)] lg:gap-0 lg:overflow-hidden lg:p-0" : "p-4 lg:min-h-0 lg:flex-1 lg:gap-0 lg:p-0",
            )}
        >
            <RecordingHeader
                variant={variant}
                recording={recording}
                transcript={transcript}
                busy={busy}
                onTranscribe={() => setTranscribeOpen(true)}
            />

            <PlayerCard
                recording={recording}
                onChanged={() => void reload()}
                sectionRef={setPlayerEl}
                showHeader={!page}
                className="rounded-2xl bg-card p-5 shadow-card lg:order-last lg:shrink-0 lg:rounded-none lg:border-t lg:border-border lg:bg-background/85 lg:px-8 lg:py-3 lg:shadow-none lg:backdrop-blur"
            />

            <Tabs
                value={tab}
                onValueChange={(v) => setTab(v as Tab)}
                className={cn("grid min-w-0 content-start gap-4", "lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:px-8 lg:pt-4", page ? "lg:pb-8" : "lg:pb-6")}
            >
                {/* The page shows its sections side by side only from 1440px; below that it uses tabs. */}
                <TabsList className={cn("grid w-full grid-cols-3", page && "min-[1440px]:hidden")} aria-label="Recording sections">
                    <TabsTrigger value="transcript" className="flex-1">Transcript</TabsTrigger>
                    <TabsTrigger value="summary" className="flex-1">Summary</TabsTrigger>
                    <TabsTrigger value="details" className="flex-1">Details</TabsTrigger>
                </TabsList>

                <div className={cn("min-w-0", page && "min-[1440px]:flex min-[1440px]:items-start min-[1440px]:gap-6")}>
                    <TabsContent
                        value="transcript"
                        forceMount
                        className={cn("min-w-0 flex-1 data-[state=inactive]:hidden", page && "min-[1440px]:block!")}
                    >
                        <TranscriptCard
                            recordingId={id}
                            recordingTitle={recording.filename}
                            transcript={transcript}
                            transcripts={transcripts}
                            selectedSource={source}
                            onSelectSource={setSource}
                            pipeline={pipe.pipeline}
                            pipelineActive={pipe.active}
                            transcribing={transcribing}
                            busy={busy}
                            onRequestTranscribe={() => setTranscribeOpen(true)}
                            onCancelPipeline={() => sendPipelineAction("cancel")}
                            onRetryPipeline={() => sendPipelineAction("retry")}
                            onChanged={() => void reload()}
                        />
                    </TabsContent>

                    <div className={cn("flex min-w-0 flex-col gap-4", page && "min-[1440px]:w-[340px] min-[1440px]:shrink-0")}>
                        <TabsContent value="summary" forceMount className={cn("min-w-0 data-[state=inactive]:hidden", page && "min-[1440px]:block!")}>
                            <SummaryPanel recordingId={id} recordingTitle={recording.filename} hasTranscript={transcript !== null} />
                        </TabsContent>
                        <TabsContent value="details" forceMount className={cn("min-w-0 data-[state=inactive]:hidden", page && "min-[1440px]:block!")}>
                            <DetailsCard recording={recording} />
                        </TabsContent>
                    </div>
                </div>
            </Tabs>

            <TranscribeDialog
                open={transcribeOpen}
                onOpenChange={setTranscribeOpen}
                hasTranscript={transcript !== null}
                onSubmit={(body) => void runTranscribe(body)}
            />
        </div>
    );
}
