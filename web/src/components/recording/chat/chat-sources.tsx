import { useEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import { timecode } from "../exports";
import { hasPlace, speakerName, type ChatCitation } from "./types";

/** The collapsible list of sources under one answer. */
export interface ChatSourcesProps {
    citations: ChatCitation[];
    /** The number each source shows, from `citationNumbers`, so it matches the badges in the text. */
    numbers: Map<string, number>;
    onOpen(citation: ChatCitation): void;
}

export function ChatSources({ citations, numbers, onOpen }: ChatSourcesProps) {
    const { t } = useI18n();
    const [open, setOpen] = useState(false);
    const list = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (open) list.current?.scrollIntoView({ block: "nearest" });
    }, [open]);
    const sorted = [...citations].sort(
        (a, b) => (numbers.get(a.sourceId) ?? Number.MAX_SAFE_INTEGER) - (numbers.get(b.sourceId) ?? Number.MAX_SAFE_INTEGER),
    );

    return (
        <div>
            <button
                type="button"
                data-testid="chat-sources-toggle"
                aria-expanded={open}
                onClick={() => setOpen((value) => !value)}
                className="flex items-center gap-1.5 rounded-md py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            >
                <ChevronRight aria-hidden="true" className={cn("size-3.5 transition-transform motion-reduce:transition-none", open && "rotate-90")} />
                <span>{t("recording.chat.sources")}</span>
                <span className="rounded-full bg-muted px-1.5 text-[11px] tabular-nums">{citations.length}</span>
            </button>
            {open ? (
                <div
                    ref={list}
                    data-testid="chat-citations"
                    aria-label={t("recording.chat.citations")}
                    className="mt-2 flex flex-col divide-y divide-border/50 overflow-hidden rounded-xl border border-border/60"
                >
                    {sorted.map((citation, index) => (
                        <SourceRow
                            key={citation.sourceId}
                            citation={citation}
                            number={numbers.get(citation.sourceId) ?? index + 1}
                            onOpen={() => onOpen(citation)}
                        />
                    ))}
                </div>
            ) : null}
        </div>
    );
}

function SourceRow({ citation, number, onOpen }: { citation: ChatCitation; number: number; onOpen(): void }) {
    const { t } = useI18n();
    const placed = hasPlace(citation);
    const time = placed && citation.startMs !== null ? timecode(citation.startMs) : null;

    return (
        <button
            type="button"
            data-testid="chat-citation"
            onClick={onOpen}
            className="flex w-full items-start gap-3 px-3 py-2 text-left transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none"
        >
            <span
                aria-hidden="true"
                className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold tabular-nums text-primary"
            >
                {number}
            </span>
            <span className="grid min-w-0 flex-1 gap-0.5">
                <span className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
                    {time ? (
                        <span
                            className="font-mono tabular-nums text-primary"
                            title={citation.approximate ? t("recording.chat.citationApproximate", { time }) : undefined}
                        >
                            {citation.approximate ? "≈" : ""}
                            {time}
                        </span>
                    ) : (
                        <span>{placed ? t("recording.chat.citationNoTime") : t("recording.chat.citationStale")}</span>
                    )}
                    {citation.speaker ? <span className="truncate">· {speakerName(citation.speaker)}</span> : null}
                </span>
                <span className="line-clamp-2 text-sm text-foreground">{citation.quote}</span>
            </span>
        </button>
    );
}
