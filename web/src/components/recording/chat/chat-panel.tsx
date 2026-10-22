import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, Copy, Info, RotateCcw, Sparkles, SquarePen, X } from "lucide-react";
import { toast } from "sonner";
import {
    AlertDialog,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { ChatComposer } from "./chat-composer";
import { ChatErrorBoundary } from "./chat-error-boundary";
import { ChatMarkdown } from "./chat-markdown";
import { ChatSources } from "./chat-sources";
import { ModelPicker, shortModel, type ChatProviderOption } from "./model-picker";
import { CITATION_MARKER, citationNumbers, type ChatCitation, type ChatTurn } from "./types";
import { useChat } from "./use-chat";

/** The longest question the server accepts (spec/recording-chat.md). */
const MAX_QUESTION = 4_000;

/** How close to the bottom still counts as reading the newest message. */
const STICK_PX = 80;

const SUGGESTIONS: MessageKey[] = [
    "recording.chat.suggestSummary",
    "recording.chat.suggestDecisions",
    "recording.chat.suggestActions",
    "recording.chat.suggestSpeakers",
];

export interface ChatPanelProps {
    recordingId: string;
    /** The transcript source the detail shows; the chat answers from it. */
    source: string | null;
    /** Called with the citation a reader chose, so the transcript can show it. */
    onCitation(citation: ChatCitation, turnId?: string): void;
    /** Closes the chat split pane. */
    onClose?(): void;
    className?: string;
}

/** Ask AI: a conversation about one recording, with answers that point back into its transcript. */
export function ChatPanel({ recordingId, source, onCitation, onClose, className }: ChatPanelProps) {
    const { t } = useI18n();
    const chat = useChat(recordingId, source);
    const [draft, setDraft] = useState("");
    const [busy, setBusy] = useState(false);
    const [providers, setProviders] = useState<ChatProviderOption[]>([]);
    const [confirmClear, setConfirmClear] = useState(false);
    const [showJump, setShowJump] = useState(false);
    const listRef = useRef<HTMLDivElement | null>(null);
    const stick = useRef(true);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);

    useEffect(() => {
        api<{ providers: ChatProviderOption[] }>("/api/settings/ai/providers")
            .then((answer) => {
                setProviders(
                    answer.providers
                        .filter((row) => row.provider !== "ElevenLabs")
                        .map((row) => ({ id: row.id, provider: row.provider, baseUrl: row.baseUrl, defaultModel: row.defaultModel })),
                );
            })
            .catch(() => setProviders([]));
    }, []);

    const preference = chat.data?.preference;
    const providerId = preference?.providerId ?? providers[0]?.id ?? "";
    const effort = preference?.effort ?? "default";
    const model = preference?.model ?? providers.find((row) => row.id === providerId)?.defaultModel ?? "";
    const providerName = preference?.provider ?? providers.find((row) => row.id === providerId)?.provider ?? null;

    const savePreference = useCallback(
        async (patch: { providerId?: string; model?: string; effort?: string }) => {
            try {
                await api(`/api/recordings/${encodeURIComponent(recordingId)}/chat`, {
                    method: "PATCH",
                    json: {
                        providerId: patch.providerId ?? providerId,
                        // A new provider starts from its own default model.
                        model: patch.model ?? (patch.providerId ? "" : model),
                        effort: patch.effort ?? effort,
                    },
                });
            } catch {
                toast.error(t("recording.chat.saveFailed"));
            }
            await chat.reload();
        },
        [chat, effort, model, providerId, recordingId, t],
    );

    const running = chat.data?.activeTurn ?? null;
    const liveText = chat.live && running && chat.live.turnId === running.id ? chat.live.text : null;
    const turns = useMemo(() => [...(chat.data?.turns ?? [])].sort((a, b) => a.seq - b.seq), [chat.data?.turns]);
    const shown = running && !turns.some((turn) => turn.id === running.id) ? [...turns, running] : turns;

    const send = async (text?: string) => {
        const question = (text ?? draft).trim();
        if (!question || busy) return;
        if (question.length > MAX_QUESTION) {
            toast.error(t("recording.chat.tooLong", { max: MAX_QUESTION }));
            return;
        }
        setBusy(true);
        stick.current = true;
        try {
            const turn = await chat.ask(question, requestId());
            if (turn && text === undefined) setDraft("");
        } finally {
            setBusy(false);
        }
    };

    const onScroll = () => {
        const list = listRef.current;
        if (!list) return;
        const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < STICK_PX;
        stick.current = atBottom;
        setShowJump(!atBottom);
    };

    const jumpLatest = () => {
        const list = listRef.current;
        if (list) list.scrollTop = list.scrollHeight;
        stick.current = true;
        setShowJump(false);
    };

    // Follows a growing answer only while the reader is at the bottom; a direct jump does not
    // fight the reader the way a smooth scroll does on every streamed word.
    useLayoutEffect(() => {
        const list = listRef.current;
        if (list && stick.current) list.scrollTop = list.scrollHeight;
    }, [liveText, shown.length, chat.status]);

    const clear = async () => {
        setConfirmClear(false);
        await chat.clear();
        toast.success(t("recording.chat.cleared"));
    };

    const blockedKey: MessageKey | null = chat.data?.blockedReason
        ? (`recording.chat.blocked${capitalise(chat.data.blockedReason)}` as MessageKey)
        : null;
    const canAsk = chat.data?.canAsk !== false;
    const empty = chat.status !== "loading" && shown.length === 0;

    return (
        <ChatErrorBoundary>
            <section
                className={cn("relative flex h-full min-h-0 flex-1 flex-col bg-background text-foreground", className)}
                data-testid="recording-chat"
                aria-label={t("recording.chat.title")}
            >
                <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-4">
                    <div className="grid min-w-0 flex-1 leading-tight">
                        <span className="text-sm font-semibold tracking-tight">{t("recording.chat.title")}</span>
                        {model || providerName ? (
                            <span className="truncate text-[11px] text-muted-foreground">
                                {[providerName, shortModel(model)].filter(Boolean).join(" · ")}
                            </span>
                        ) : null}
                    </div>
                    <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 text-muted-foreground hover:text-foreground"
                        data-testid="chat-clear"
                        aria-label={t("recording.chat.newChat")}
                        title={t("recording.chat.newChat")}
                        disabled={turns.length === 0 && !running}
                        onClick={() => setConfirmClear(true)}
                    >
                        <SquarePen className="size-4" />
                    </Button>
                    {onClose && (
                        <Button
                            variant="ghost"
                            size="icon"
                            className="size-8 text-muted-foreground hover:text-foreground"
                            data-testid="chat-close"
                            aria-label={t("recording.chat.close")}
                            title={t("recording.chat.close")}
                            onClick={onClose}
                        >
                            <X className="size-4" />
                        </Button>
                    )}
                </header>

                <div ref={listRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-4 py-6" data-testid="chat-messages">
                    {empty ? (
                        <div className="mx-auto flex min-h-full max-w-md flex-col items-center justify-center text-center" data-testid="chat-empty">
                            <div className="mb-3 flex size-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                                <Sparkles className="size-5" />
                            </div>
                            <h3 className="text-[15px] font-semibold">{t("recording.chat.title")}</h3>
                            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{emptyText(t, chat.data?.blockedReason ?? null)}</p>
                            {chat.data?.canAsk ? (
                                <>
                                    <p className="mb-2 mt-6 self-start text-[11px] font-medium text-muted-foreground">{t("recording.chat.suggestTitle")}</p>
                                    <div className="grid w-full gap-2 sm:grid-cols-2">
                                        {SUGGESTIONS.map((key) => (
                                            <button
                                                key={key}
                                                type="button"
                                                data-testid="chat-suggestion"
                                                disabled={busy}
                                                onClick={() => void send(t(key))}
                                                className="rounded-xl border border-border/70 bg-card px-3 py-2.5 text-left text-sm text-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
                                            >
                                                {t(key)}
                                            </button>
                                        ))}
                                    </div>
                                    {providerName ? (
                                        <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground/80">
                                            {t("recording.chat.providerSwitch", { provider: providerName })}
                                        </p>
                                    ) : null}
                                </>
                            ) : null}
                        </div>
                    ) : (
                        <div className="mx-auto flex max-w-2xl flex-col gap-8">
                            {shown.map((turn) => (
                                <TurnItem
                                    key={turn.id}
                                    recordingId={recordingId}
                                    turn={turn}
                                    liveText={turn.id === running?.id ? liveText : null}
                                    anotherRunning={running !== null && running.id !== turn.id}
                                    onCitation={onCitation}
                                    onRetry={() => void chat.retry(turn.id)}
                                />
                            ))}
                        </div>
                    )}
                </div>

                {showJump && !empty ? (
                    <div className="pointer-events-none absolute inset-x-0 bottom-36 flex justify-center">
                        <Button
                            variant="secondary"
                            size="sm"
                            className="pointer-events-auto h-7 gap-1.5 rounded-full px-3 text-xs shadow-md"
                            onClick={jumpLatest}
                        >
                            <ArrowDown className="size-3" />
                            {t("recording.chat.jumpLatest")}
                        </Button>
                    </div>
                ) : null}

                <div className="shrink-0 px-4 pb-4 pt-2">
                    {blockedKey && (
                        <p className="pb-2 text-center text-xs text-muted-foreground" data-testid="chat-blocked">
                            {t(blockedKey)}
                        </p>
                    )}
                    {chat.message && <p className="pb-2 text-center text-xs text-destructive">{chat.message}</p>}
                    <ChatComposer
                        value={draft}
                        onChange={setDraft}
                        onSend={() => void send()}
                        onStop={() => {
                            if (running) void chat.stop(running.id);
                        }}
                        running={running !== null}
                        sending={busy}
                        disabled={chat.data?.blockedReason === "noTranscript"}
                        canAsk={canAsk}
                        textareaRef={textareaRef}
                        picker={
                            <ModelPicker
                                providers={providers}
                                providerId={providerId}
                                model={model}
                                effort={effort}
                                efforts={chat.data?.capabilities.effort ?? []}
                                effortKnown={chat.data?.capabilities.known ?? false}
                                disabled={providers.length === 0}
                                onChange={(patch) => void savePreference(patch)}
                            />
                        }
                    />
                </div>

                <AlertDialog open={confirmClear} onOpenChange={setConfirmClear}>
                    <AlertDialogContent>
                        <AlertDialogTitle>{t("recording.chat.clearTitle")}</AlertDialogTitle>
                        <AlertDialogDescription>{t("recording.chat.clearBody")}</AlertDialogDescription>
                        <AlertDialogFooter>
                            <AlertDialogCancel asChild>
                                <Button variant="secondary">{t("common.action.cancel")}</Button>
                            </AlertDialogCancel>
                            <Button variant="destructive" data-testid="chat-clear-confirm" onClick={() => void clear()}>
                                {t("recording.chat.clear")}
                            </Button>
                        </AlertDialogFooter>
                    </AlertDialogContent>
                </AlertDialog>
            </section>
        </ChatErrorBoundary>
    );
}

interface TurnItemProps {
    recordingId: string;
    turn: ChatTurn;
    liveText: string | null;
    /** Another answer is running, so this one cannot be asked again yet. */
    anotherRunning: boolean;
    onCitation(citation: ChatCitation, turnId?: string): void;
    onRetry(): void;
}

function TurnItem({ recordingId, turn, liveText, anotherRunning, onCitation, onRetry }: TurnItemProps) {
    const { t } = useI18n();
    const text = (liveText ?? turn.answer) || "";
    const running = turn.status === "pending" || turn.status === "running";
    const failed = turn.status === "failed" || turn.status === "interrupted" || (turn.status === "cancelled" && !text);
    const stopped = turn.status === "cancelled" && Boolean(text);
    const numbers = useMemo(() => citationNumbers(text, turn.citations), [text, turn.citations]);

    const copy = () => {
        const plain = text.replace(CITATION_MARKER, "").replace(/[ \t]+([.,;:!?。，；：！？])/g, "$1");
        void navigator.clipboard?.writeText(plain).then(() => toast.success(t("recording.chat.copied")));
    };

    return (
        <div className="group flex flex-col gap-3" data-testid="chat-turn" data-status={turn.status}>
            <div className="flex justify-end">
                <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-primary/10 px-4 py-2.5 text-[15px] leading-6 text-foreground [overflow-wrap:anywhere]">
                    {turn.question}
                </div>
            </div>

            <div className="flex flex-col gap-3">
                {running && !text ? (
                    <div data-testid="chat-thinking" className="flex items-center gap-2.5 py-1 text-xs text-muted-foreground">
                        <span aria-hidden="true" className="flex items-center gap-1">
                            <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:-0.3s] motion-reduce:animate-none" />
                            <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:-0.15s] motion-reduce:animate-none" />
                            <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60 motion-reduce:animate-none" />
                        </span>
                        <span>{t("recording.chat.reading")}</span>
                    </div>
                ) : null}

                {text ? (
                    <ChatMarkdown
                        content={text}
                        streaming={running}
                        recordingId={recordingId}
                        turnId={turn.id}
                        citations={turn.citations}
                        onCitationSelect={(citation) => onCitation(citation, turn.id)}
                    />
                ) : null}

                {stopped ? <p className="text-xs text-muted-foreground">{t("recording.chat.stopped")}</p> : null}

                {turn.status === "completed" && turn.partial ? (
                    <p className="flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground" data-testid="chat-partial">
                        <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                        {t("recording.chat.partialNote")}
                    </p>
                ) : null}

                {turn.current === false && text ? (
                    <p className="flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground" data-testid="chat-stale">
                        <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                        {t("recording.chat.staleTranscript")}
                    </p>
                ) : null}

                {failed ? (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm">
                        <span className="font-medium text-foreground">{failureText(t, turn.status)}</span>
                        {turn.error?.message ? <span className="min-w-0 flex-1 text-xs text-muted-foreground">{turn.error.message}</span> : null}
                        <Button variant="secondary" size="sm" className="h-7 px-2.5 text-xs" disabled={anotherRunning} onClick={onRetry}>
                            {t("recording.chat.failedRetry")}
                        </Button>
                    </div>
                ) : null}

                {!running && turn.citations.length > 0 ? (
                    <ChatSources citations={turn.citations} numbers={numbers} onOpen={(citation) => onCitation(citation, turn.id)} />
                ) : null}

                {!running && text && !failed ? (
                    <div className="-ml-1.5 flex items-center gap-0.5 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100">
                        <Button
                            variant="ghost"
                            size="icon"
                            className="size-7 text-muted-foreground hover:text-foreground"
                            aria-label={t("recording.chat.copy")}
                            title={t("recording.chat.copy")}
                            onClick={copy}
                        >
                            <Copy className="size-3.5" />
                        </Button>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="size-7 text-muted-foreground hover:text-foreground"
                            aria-label={t("recording.chat.retry")}
                            title={t("recording.chat.retry")}
                            disabled={anotherRunning}
                            onClick={onRetry}
                        >
                            <RotateCcw className="size-3.5" />
                        </Button>
                    </div>
                ) : null}
            </div>
        </div>
    );
}

function emptyText(t: (key: MessageKey) => string, blocked: string | null): string {
    if (blocked === "noTranscript") return t("recording.chat.emptyNoTranscript");
    if (blocked === "noProvider") return t("recording.chat.emptyNoProvider");
    if (blocked === "providerMissing") return t("recording.chat.emptyProviderMissing");
    return t("recording.chat.empty");
}

function failureText(t: (key: MessageKey) => string, status: string): string {
    if (status === "cancelled") return t("recording.chat.failedStopped");
    if (status === "interrupted") return t("recording.chat.interrupted");
    return t("recording.chat.failed");
}

function capitalise(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1);
}

function requestId(): string {
    return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
