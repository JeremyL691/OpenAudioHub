import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
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
import { recordingFullViewPath } from "@/lib/recording-navigation";
import { DetailsCard } from "./details-card";
import { useRecordingDetail, usePipelineWatch } from "./data";
import { RecordingHeader } from "./recording-header";
import { SummaryPanel } from "./summary-panel";
import { TranscribeDialog, TranscriptCard } from "./transcript-card";
import { ChatPanel } from "./chat/chat-panel";
import type { ChatCitation, CitationFocus, CitationPlace, CitationTarget } from "./chat/types";
import { chatCitationPath, hasPlace } from "./chat/types";
import type { TranscriptRecord } from "./types";
import { useI18n } from "@/lib/i18n";

export interface RecordingDetailProps {
    id: string;
    /** "page" is /recordings/:id (a full view). "pane" is the detail pane beside the library list. */
    variant: "page" | "pane";
}

type Tab = "transcript" | "summary" | "details";

/** The recording view: header, player, transcript, summary, details and Ask AI split view. */
export function RecordingDetail(props: RecordingDetailProps) {
    return <RecordingDetailView key={props.id} {...props} />;
}

function RecordingDetailView({ id, variant }: RecordingDetailProps) {
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const { t } = useI18n();
    const page = variant === "page";

    const detail = useRecordingDetail(id);
    const { data, reload } = detail;
    const pipe = usePipelineWatch(id, () => {
        void reload();
        window.dispatchEvent(new Event(RECORDINGS_CHANGED));
    });
    const player = usePlayer();
    const playerRef = useRef(player);
    useEffect(() => {
        playerRef.current = player;
    });

    const handledCitationHashRef = useRef<string | null>(null);
    const setPlayerOnScreen = player?.setPlayerOnScreen;
    const [transcribing, setTranscribing] = useState(false);
    const [transcribeOpen, setTranscribeOpen] = useState(false);
    const [source, setSource] = useState<string | null>(null);
    const [tab, setTab] = useState<Tab>("transcript");
    const [playerEl, setPlayerEl] = useState<HTMLDivElement | null>(null);

    const [chatOpen, setChatOpen] = useState(() => page && searchParams.get("chat") === "1");
    const [wide, setWide] = useState(false);
    const [shellEl, setShellEl] = useState<HTMLDivElement | null>(null);
    const [citationFocus, setCitationFocus] = useState<CitationFocus | null>(null);

    const handleHighlightShown = useCallback(() => {
        setCitationFocus(null);
    }, []);

    /** Marks a cited place in the transcript and moves the player to it when it has a time. */
    const focusOn = useCallback((place: CitationPlace & { startMs: number | null; endMs: number | null }) => {
        setCitationFocus({
            segmentStart: place.segmentStart,
            segmentEnd: place.segmentEnd,
            line: place.line,
            lineStart: place.lineStart,
            lineEnd: place.lineEnd,
            startMs: place.startMs,
            endMs: place.endMs,
            key: Date.now(),
        });
        if (place.startMs !== null && playerRef.current) playerRef.current.seek(place.startMs / 1000);
    }, []);

    useEffect(() => {
        if (page) {
            setChatOpen(searchParams.get("chat") === "1");
        }
    }, [page, searchParams]);

    useEffect(() => {
        if (!shellEl) return;
        const observer = new ResizeObserver(([entry]) => {
            setWide(entry.contentRect.width >= 860);
        });
        observer.observe(shellEl);
        return () => observer.disconnect();
    }, [shellEl]);

    const closeChat = () => {
        setChatOpen(false);
    };

    const toggleChat = () => {
        if (!page) {
            navigate(recordingFullViewPath(id, true), { state: { fromLibrary: true } });
            return;
        }
        setChatOpen((open) => !open);
    };

    /**
     * Shows where a citation's words are.
     *
     * A citation names the transcript rows it covers, so the transcript marks exactly those and the
     * player moves to their start. A citation from an older transcript keeps its text only; the
     * server is asked where it belongs, and when it no longer belongs anywhere the reader is told.
     */
    const openCitation = useCallback(
        async (citation: ChatCitation, turnId?: string) => {
            setTab("transcript");
            if (!wide && page) {
                closeChat();
            }
            if (turnId) {
                const newHash = `#citation=${encodeURIComponent(turnId)}:${encodeURIComponent(citation.sourceId)}`;
                handledCitationHashRef.current = `${id}:${newHash}`;
                window.history.replaceState(window.history.state, "", newHash);
            }
            if (hasPlace(citation)) {
                focusOn(citation);
                return;
            }
            if (!turnId) {
                setCitationFocus(null);
                toast.info(t("recording.chat.citationStale"));
                return;
            }
            try {
                const target = await api<CitationTarget>(chatCitationPath(id, turnId, citation.sourceId));
                if (target.source) setSource(target.source);
                if (target.current && hasPlace(target)) {
                    focusOn(target);
                } else {
                    setCitationFocus(null);
                    toast.info(t("recording.chat.citationStale"));
                }
            } catch {
                setCitationFocus(null);
                toast.info(t("recording.chat.citationStale"));
            }
        },
        [id, wide, page, focusOn, t],
    );

    useEffect(() => {
        const hash = window.location.hash;
        if (!hash.startsWith("#citation=")) return;
        const key = `${id}:${hash}`;
        if (handledCitationHashRef.current === key) return;
        handledCitationHashRef.current = key;

        const parts = hash.slice("#citation=".length).split(":");
        if (parts.length !== 2) return;
        const [turnId, sourceId] = parts.map(decodeURIComponent);
        api<CitationTarget>(chatCitationPath(id, turnId, sourceId))
            .then((target) => {
                if (!target) return;
                setTab("transcript");
                if (target.source) setSource(target.source);
                if (target.current && hasPlace(target)) focusOn(target);
            })
            .catch(() => undefined);
    }, [id, focusOn]);

    const isChatActive = page && chatOpen;

    useEffect(() => {
        if (!page || !setPlayerOnScreen || !playerEl) return;
        if (!wide && chatOpen) {
            setPlayerOnScreen(true);
            return;
        }
        const observer = new IntersectionObserver(([entry]) => setPlayerOnScreen(entry.isIntersecting));
        observer.observe(playerEl);
        return () => {
            observer.disconnect();
            setPlayerOnScreen(true);
        };
    }, [page, setPlayerOnScreen, playerEl, wide, chatOpen]);

    if (detail.status === "loading") {
        return (
            <div className="grid place-items-center p-10">
                <Spinner label={t("recording.detail.loading")} />
            </div>
        );
    }

    if (detail.status === "missing") {
        return (
            <EmptyState
                title={t("recording.detail.missingTitle")}
                description={t("recording.detail.missingBody")}
                action={
                    <Button variant="secondary" onClick={() => navigate("/recordings")}>
                        {t("recording.header.backToRecordings")}
                    </Button>
                }
            />
        );
    }

    if (!data) {
        return (
            <EmptyState
                title={t("recording.detail.loadFailedTitle")}
                description={detail.message ?? t("recording.detail.loadFailedBody")}
                action={
                    <Button variant="secondary" onClick={() => void reload()}>
                        {t("common.action.retry")}
                    </Button>
                }
            />
        );
    }

    const { recording } = data;
    const transcripts: TranscriptRecord[] = data.transcriptions ?? (data.transcription ? [data.transcription] : []);
    const transcript = transcripts.find((tr) => tr.source === source) ?? transcripts[0] ?? null;
    const busy = transcribing || pipe.active;

    const runTranscribe = async (body: { providerId?: string; model?: string }) => {
        setTranscribeOpen(false);
        setTranscribing(true);
        try {
            const answer = await api<{ jobId?: string }>(`/api/recordings/${encodeURIComponent(id)}/transcribe`, { method: "POST", json: body });
            if (answer && typeof answer === "object" && "jobId" in answer) {
                pipe.queue();
            } else {
                toast.success(t("recording.transcribe.complete"));
            }
            await reload();
            window.dispatchEvent(new Event(RECORDINGS_CHANGED));
        } catch (err) {
            toast.error(errorMessage(err, t("recording.transcribe.failed")));
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
            toast.error(errorMessage(err, action === "retry" ? t("recording.pipeline.retryFailed") : t("recording.pipeline.cancelFailed")));
        }
    };

    return (
        <div
            ref={setShellEl}
            className={cn(
                "flex min-w-0 flex-1 flex-col",
                page ? "px-4 py-6 lg:h-[calc(100svh-3.25rem)] lg:overflow-hidden lg:p-0" : "p-4 lg:min-h-0 lg:flex-1 lg:p-0",
            )}
        >
            <RecordingHeader
                variant={variant}
                recording={recording}
                transcript={transcript}
                busy={busy}
                chatOpen={isChatActive}
                onTranscribe={() => setTranscribeOpen(true)}
                onAskAi={toggleChat}
            />

            {/* Main split-screen container: Left and Right on the exact same plane */}
            <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden" data-testid="recording-split">
                {/* Left column: Player and Content Tabs */}
                <div
                    className={cn(
                        "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
                        page && !wide && chatOpen && "hidden",
                    )}
                >
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
                        className={cn(
                            "flex min-h-0 min-w-0 flex-1 flex-col content-start gap-4",
                            "overflow-y-auto px-4 lg:px-8 pt-4",
                            page ? "pb-8" : "pb-6",
                        )}
                    >
                        {/* Tabs List: strictly Transcript, Summary, Details */}
                        <TabsList
                            className={cn(
                                "grid w-full shrink-0 grid-cols-3",
                                page && !chatOpen && wide && "min-[1440px]:hidden",
                            )}
                            aria-label={t("recording.detail.sections")}
                        >
                            <TabsTrigger value="transcript" className="flex-1">{t("recording.tabs.transcript")}</TabsTrigger>
                            <TabsTrigger value="summary" className="flex-1">{t("recording.tabs.summary")}</TabsTrigger>
                            <TabsTrigger value="details" className="flex-1">{t("recording.tabs.details")}</TabsTrigger>
                        </TabsList>

                        {/* Content views */}
                        <div className={cn("min-h-0 flex-1 min-w-0", page && !chatOpen && wide && "min-[1440px]:flex min-[1440px]:items-start min-[1440px]:gap-6")}>
                            <TabsContent
                                value="transcript"
                                forceMount
                                className={cn(
                                    "min-w-0 flex-1 data-[state=inactive]:hidden",
                                    page && !chatOpen && wide && "min-[1440px]:block!",
                                )}
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
                                    citationFocus={citationFocus}
                                    onHighlightShown={handleHighlightShown}
                                />
                            </TabsContent>

                            <div className={cn("flex min-w-0 flex-col gap-4", page && !chatOpen && wide && "min-[1440px]:w-[340px] min-[1440px]:shrink-0")}>
                                <TabsContent value="summary" forceMount className={cn("min-w-0 data-[state=inactive]:hidden", page && !chatOpen && wide && "min-[1440px]:block!")}>
                                    <SummaryPanel recordingId={id} recordingTitle={recording.filename} hasTranscript={transcript !== null} />
                                </TabsContent>
                                <TabsContent value="details" forceMount className={cn("min-w-0 data-[state=inactive]:hidden", page && !chatOpen && wide && "min-[1440px]:block!")}>
                                    <DetailsCard recording={recording} />
                                </TabsContent>
                            </div>
                        </div>
                    </Tabs>
                </div>

                {/* Right column: Ask AI Panel on the exact same plane: single persistent instance */}
                {page && (
                    <aside
                        className={cn(
                            "flex min-h-0 flex-col bg-background transition-all",
                            wide
                                ? "w-[420px] lg:w-[460px] xl:w-[500px] shrink-0 border-l border-border"
                                : "flex-1",
                            !chatOpen && "hidden",
                        )}
                        data-testid={wide ? "recording-chat-dock" : undefined}
                    >
                        <ChatPanel
                            recordingId={id}
                            source={transcript?.source ?? null}
                            onCitation={openCitation}
                            onClose={closeChat}
                        />
                    </aside>
                )}
            </div>

            <TranscribeDialog
                open={transcribeOpen}
                onOpenChange={setTranscribeOpen}
                hasTranscript={transcript !== null}
                onSubmit={(body) => void runTranscribe(body)}
            />
        </div>
    );
}
