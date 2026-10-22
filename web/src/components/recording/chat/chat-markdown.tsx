import { useMemo } from "react";
import { Marked } from "marked";
import { safeHref } from "@/pages/docs/markdown";
import { useI18n } from "@/lib/i18n";
import { timecode } from "../exports";
import { citationNumbers, hasPlace, speakerName, type ChatCitation } from "./types";

export interface ChatMarkdownProps {
    content: string;
    streaming?: boolean;
    recordingId?: string;
    turnId?: string;
    citations?: ChatCitation[];
    onCitationSelect?(citation: ChatCitation): void;
}

/** A citation marker the model may write, in any of the shapes providers produce. */
const MARKER = /^[\[【]\s*(src_\d+(?:\s*[,，、]\s*src_\d+)*)\s*[\]】]/;

/**
 * Renders assistant messages as formatted Markdown with sanitized links and code blocks.
 *
 * A source marker becomes a small numbered badge: the first source an answer cites is 1, the next
 * new one is 2, and a repeated source keeps its number. Markers that name no checked source are
 * dropped, so a reader never sees `src_12` in the answer.
 */
export function ChatMarkdown({
    content,
    streaming = false,
    recordingId,
    turnId,
    citations,
    onCitationSelect,
}: ChatMarkdownProps) {
    const { t } = useI18n();
    const citationsMap = useMemo(() => {
        const map = new Map<string, ChatCitation>();
        if (citations) {
            for (const c of citations) {
                map.set(c.sourceId, c);
            }
        }
        return map;
    }, [citations]);

    /** The number each source is shown as, in the order the answer first cites it. */
    const numbers = useMemo(() => citationNumbers(content, citations ?? []), [content, citations]);

    const badge = (sourceId: string): string => {
        const citation = citationsMap.get(sourceId);
        const number = numbers.get(sourceId);
        if (!citation || number === undefined) return "";
        const safeRec = recordingId ? encodeURIComponent(recordingId) : "";
        const safeTurn = turnId ? encodeURIComponent(turnId) : "";
        const safeSrc = encodeURIComponent(sourceId);
        const href = `/recordings/${safeRec}?chat=1#citation=${safeTurn}:${safeSrc}`;
        const placed = hasPlace(citation);
        const when =
            placed && citation.startMs !== null
                ? `${citation.approximate ? "≈" : ""}${timecode(citation.startMs)}`
                : placed
                  ? ""
                  : t("recording.chat.citationStale");
        const speaker = citation.speaker ? speakerName(citation.speaker) : "";
        const where = [when, speaker].filter(Boolean).join(" · ");
        // The badge shows a number only, so its accessible name says what it points at.
        const named = t("recording.chat.citationNumber", { number });
        const label = where ? `${named}, ${where}. ${citation.quote}` : `${named}. ${citation.quote}`;
        const title = where ? `${where}\n${citation.quote}` : citation.quote;
        return `<a href="${href}" data-testid="chat-citation-link" data-source-id="${safeSrc}" aria-label="${escapeHtml(label)}" title="${escapeHtml(title)}" class="chat-citation-link mx-[0.08rem] inline-flex h-[18px] min-w-[18px] cursor-pointer items-center justify-center rounded-full bg-primary/10 px-1 align-[2px] text-[10.5px] font-semibold leading-none tabular-nums text-primary no-underline transition-colors hover:bg-primary hover:text-primary-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring">${number}</a>`;
    };

    const html = useMemo(() => {
        if (!content.trim()) return "";
        const md = new Marked({
            gfm: true,
            breaks: true,
        });

        md.use({
            extensions: [
                {
                    name: "citation",
                    level: "inline",
                    start(src) {
                        return src.search(/[\[【]/);
                    },
                    tokenizer(src) {
                        const match = MARKER.exec(src);
                        if (!match) return undefined;
                        return {
                            type: "citation",
                            raw: match[0],
                            ids: match[1].split(/[,，、]/).map((id) => id.trim()),
                        };
                    },
                    renderer(token) {
                        const ids = (token as unknown as { ids: string[] }).ids;
                        const badges = ids.map(badge).filter(Boolean);
                        if (badges.length === 0) return "";
                        // Neighbouring badges read as one group rather than a run of words.
                        return `<span class="chat-citation-group mx-[0.08rem] inline-flex items-center gap-[0.15rem] align-baseline">${badges.join("")}</span>`;
                    },
                },
            ],
            renderer: {
                link({ href, title, tokens: inner }) {
                    const target = safeHref(href);
                    if (!target) return this.parser.parseInline(inner);
                    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
                    const external = /^https?:\/\//.test(target);
                    const rel = external ? ' rel="noopener noreferrer" target="_blank"' : "";
                    return `<a href="${escapeHtml(target)}"${titleAttr}${rel} class="text-primary hover:underline underline-offset-4">${this.parser.parseInline(inner)}</a>`;
                },
                code({ text, lang }) {
                    const languageClass = lang ? ` class="language-${escapeHtml(lang)}"` : "";
                    return `<pre class="my-3 overflow-x-auto rounded-lg bg-muted p-3 font-mono text-[13px] leading-6 text-foreground"><code${languageClass}>${escapeHtml(text)}</code></pre>`;
                },
                codespan({ text }) {
                    return `<code class="rounded bg-muted px-1 py-0.5 font-mono text-[13px] text-foreground">${escapeHtml(text)}</code>`;
                },
                paragraph({ tokens: inner }) {
                    return `<p class="my-3 first:mt-0 last:mb-0">${this.parser.parseInline(inner)}</p>`;
                },
                list({ ordered, items }) {
                    const tag = ordered ? "ol" : "ul";
                    const listClass = ordered
                        ? "my-3 list-decimal space-y-1.5 pl-5 first:mt-0 last:mb-0 marker:text-muted-foreground"
                        : "my-3 list-disc space-y-1.5 pl-5 first:mt-0 last:mb-0 marker:text-muted-foreground";
                    const body = items
                        .map((item) => `<li class="pl-1">${item.loose ? this.parser.parse(item.tokens) : this.parser.parseInline(item.tokens)}</li>`)
                        .join("");
                    return `<${tag} class="${listClass}">${body}</${tag}>`;
                },
                blockquote({ tokens: inner }) {
                    return `<blockquote class="my-3 border-l-2 border-border pl-3 text-muted-foreground">${this.parser.parse(inner)}</blockquote>`;
                },
                heading({ tokens: inner, depth }) {
                    const sizes: Record<number, string> = {
                        1: "mb-2 mt-5 text-base font-semibold first:mt-0",
                        2: "mb-2 mt-5 text-[15px] font-semibold first:mt-0",
                        3: "mb-1.5 mt-4 text-[15px] font-semibold first:mt-0",
                        4: "mb-1 mt-3 text-[15px] font-medium first:mt-0",
                    };
                    const headingClass = sizes[depth] ?? sizes[4];
                    return `<h${depth} class="${headingClass}">${this.parser.parseInline(inner)}</h${depth}>`;
                },
            },
        });

        return md.parse(content) as string;
    }, [content, citationsMap, recordingId, turnId, numbers, t]);

    const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
        const link = (e.target as HTMLElement).closest<HTMLAnchorElement>("a[data-source-id]");
        if (link && onCitationSelect) {
            const sourceId = link.getAttribute("data-source-id");
            if (sourceId && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) {
                e.preventDefault();
                const citation = citationsMap.get(sourceId);
                if (citation) {
                    onCitationSelect(citation);
                }
            }
        }
    };

    return (
        <div
            className="chat-markdown max-w-none text-[15px] leading-7 text-foreground [overflow-wrap:anywhere] [&_hr]:my-4 [&_hr]:border-border [&_strong]:font-semibold [&_table]:my-3 [&_table]:w-full [&_table]:text-sm [&_td]:border-b [&_td]:border-border/50 [&_td]:px-2 [&_td]:py-1 [&_th]:border-b [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left"
            onClick={handleClick}
        >
            <div dangerouslySetInnerHTML={{ __html: html }} />
            {streaming && (
                <span
                    aria-hidden="true"
                    className="ml-0.5 inline-block h-4 w-[2px] translate-y-[3px] animate-pulse rounded-full bg-primary/70 motion-reduce:animate-none"
                />
            )}
        </div>
    );
}

function escapeHtml(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
