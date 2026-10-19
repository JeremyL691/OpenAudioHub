import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Copy, Download, ListChecks, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Select, type SelectOption } from "@/components/ui/select";
import { api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { RECORDINGS_CHANGED } from "@/lib/recordings";
import { downloadText, safeFileName, summaryMarkdown, summaryPlain } from "./exports";
import type { CustomSummaryPrompt, SummaryData, UserSummarySettings } from "./types";

/** Built-in summary templates (spec/ai.md, "Summary presets"). */
export const SUMMARY_PRESETS: { id: string; name: string }[] = [
    { id: "general", name: "General Summary" },
    { id: "meeting-notes", name: "Meeting Minutes" },
    { id: "interview", name: "Interview and Research" },
    { id: "call", name: "Phone and Client Call" },
    { id: "lecture", name: "Lecture and Study Notes" },
    { id: "brainstorm", name: "Brainstorm" },
    { id: "voice-memo", name: "Voice Memo and Podcast" },
    { id: "key-points", name: "Key Points" },
    { id: "action-items", name: "Action Items" },
];

const LANGUAGES: SelectOption[] = [
    { value: "auto", label: "Auto (match transcript)" },
    { value: "en", label: "English" },
    { value: "zh", label: "Chinese" },
    { value: "ja", label: "Japanese" },
    { value: "ko", label: "Korean" },
];

const POLL_MS = 1500;

export interface SummaryPanelProps {
    recordingId: string;
    recordingTitle: string;
    hasTranscript: boolean;
}

/** Summary of a recording: template and language, generate, key points, action items, copy, export and delete. */
export function SummaryPanel({ recordingId, recordingTitle, hasTranscript }: SummaryPanelProps) {
    const [summary, setSummary] = useState<SummaryData | null>(null);
    const [loaded, setLoaded] = useState(false);
    const [generating, setGenerating] = useState(false);
    const [template, setTemplate] = useState<string | null>(null);
    const [language, setLanguage] = useState("auto");
    const [customPrompts, setCustomPrompts] = useState<CustomSummaryPrompt[]>([]);
    const [savedTemplate, setSavedTemplate] = useState("general");
    const userPicked = useRef(false);

    const alive = useRef(true);
    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
        };
    }, [recordingId]);

    const load = useCallback(async () => {
        try {
            const data = await api<SummaryData>(`/api/recordings/${encodeURIComponent(recordingId)}/summary`);
            // A run that finished elsewhere may arrive after the panel moved to another recording.
            if (!alive.current) return;
            setSummary(data);
        } catch (err) {
            if (!alive.current) return;
            toast.error(errorMessage(err, "Could not load the summary"));
        } finally {
            if (alive.current) setLoaded(true);
        }
    }, [recordingId]);

    useEffect(() => {
        void load();
    }, [load]);

    // A transcript that arrives, or a run that finishes, changes the list; re-read so the pane
    // never keeps an empty result the library no longer shows.
    useEffect(() => {
        const onChange = () => void load();
        window.addEventListener(RECORDINGS_CHANGED, onChange);
        return () => window.removeEventListener(RECORDINGS_CHANGED, onChange);
    }, [load]);

    // The template saved in settings is the default choice.
    useEffect(() => {
        let alive = true;
        api<UserSummarySettings>("/api/settings/user")
            .then((s) => {
                if (!alive) return;
                const selected = s.summaryPrompt?.selectedPrompt ?? "general";
                setSavedTemplate(selected);
                setCustomPrompts(s.summaryPrompt?.customPrompts ?? []);
                if (!userPicked.current) setTemplate(selected);
            })
            .catch(() => undefined);
        return () => {
            alive = false;
        };
    }, []);

    // Another run may be generating this summary, from a reload or the automatic step. Poll until it ends.
    const status = summary?.status;
    const serverGenerating = status ? status === "queued" || status === "running" : summary?.generating === true;
    useEffect(() => {
        if (!serverGenerating) return;
        const timer = window.setTimeout(() => void load(), POLL_MS);
        return () => window.clearTimeout(timer);
    }, [serverGenerating, load, summary]);

    // A finished run refreshes the library list, so its row leaves "Summarizing" at once.
    const wasGenerating = useRef(false);
    useEffect(() => {
        if (wasGenerating.current && !serverGenerating) {
            window.dispatchEvent(new Event(RECORDINGS_CHANGED));
        }
        wasGenerating.current = serverGenerating;
    }, [serverGenerating]);

    const templateOptions: SelectOption[] = [
        ...SUMMARY_PRESETS.map((p) => ({ value: p.id, label: p.name })),
        ...customPrompts.map((p) => ({ value: p.id, label: p.name })),
    ];
    const chosenTemplate = template ?? savedTemplate;
    const templateName = templateOptions.find((o) => o.value === (summary?.promptId ?? chosenTemplate))?.label;
    const busy = generating || serverGenerating;
    const hasSummary = hasSummaryContent(summary);
    const failed = status === "failed" ? summary?.error ?? "The summary could not be made." : null;

    const generate = async () => {
        setGenerating(true);
        // The list shows "Summarizing" while the request runs.
        window.dispatchEvent(new Event(RECORDINGS_CHANGED));
        try {
            const next = await api<SummaryData>(`/api/recordings/${encodeURIComponent(recordingId)}/summary`, {
                method: "POST",
                json: { preset: chosenTemplate, language },
            });
            setSummary({ ...next, generating: false });
        } catch (err) {
            toast.error(errorMessage(err, "Summary failed"));
        } finally {
            setGenerating(false);
            // The run ended, one way or the other; the row badge follows.
            window.dispatchEvent(new Event(RECORDINGS_CHANGED));
        }
    };

    const remove = async () => {
        try {
            await api(`/api/recordings/${encodeURIComponent(recordingId)}/summary`, { method: "DELETE" });
            setSummary({ summary: null, keyPoints: [], actionItems: [], generating: false });
            toast.success("Summary deleted");
            window.dispatchEvent(new Event(RECORDINGS_CHANGED));
        } catch (err) {
            toast.error(errorMessage(err, "Could not delete the summary"));
        }
    };

    const exportInput = () => {
        const meta = [
            templateName,
            LANGUAGES.find((l) => l.value === summary?.language)?.label,
            summary?.model,
        ].filter((x): x is string => Boolean(x));
        return {
            title: `${recordingTitle} summary`,
            summary: summary?.summary ?? "",
            keyPoints: summary?.keyPoints ?? [],
            actionItems: summary?.actionItems ?? [],
            meta,
        };
    };

    const base = safeFileName(recordingTitle ? `${recordingTitle} summary` : "Summary", "Summary");

    const selects = busy ? null : (
        <>
            <Field label={<span className="sr-only">Summary language</span>} className="gap-0">
                <Select value={language} onValueChange={setLanguage} options={LANGUAGES} className="w-44 max-w-full [&>span:first-child]:truncate" />
            </Field>
            <Field label={<span className="sr-only">Template</span>} className="gap-0">
                <Select
                    value={chosenTemplate}
                    onValueChange={(next) => {
                        userPicked.current = true;
                        setTemplate(next);
                    }}
                    options={templateOptions}
                    className="w-44 max-w-full [&>span:first-child]:truncate"
                />
            </Field>
        </>
    );

    return (
        <Card className="content-start" data-testid="summary-panel">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-[17px] font-semibold tracking-tight">Summary</h2>
                {hasTranscript ? (
                    <div className="flex flex-wrap items-center gap-2">
                        {selects}
                        <Button variant="secondary" data-testid="summary-generate" disabled={busy || !loaded} onClick={() => void generate()}>
                            {busy ? null : hasSummary ? <RefreshCw aria-hidden="true" /> : <Sparkles aria-hidden="true" />}
                            {busy ? "Generating…" : hasSummary ? "Re-generate" : "Summarize"}
                        </Button>
                    </div>
                ) : null}
            </div>

            {!hasTranscript ? (
                <p className="mt-2 text-sm text-muted-foreground">A summary is available once the recording has a transcript.</p>
            ) : (
                <>
                    {failed && !busy ? (
                        <p role="alert" data-testid="summary-error" className="mt-4 text-sm text-destructive">
                            {failed}
                        </p>
                    ) : null}
                    {hasSummary && summary ? (
                        <div data-testid="summary-content" className="mt-4 grid gap-4 text-sm leading-6 text-foreground">
                            {summary.summary?.trim() ? <Formatted text={summary.summary} /> : null}
                            {summary.keyPoints?.length ? <ListSection title="Key Points" items={summary.keyPoints} /> : null}
                            {summary.actionItems?.length ? <ActionSection items={summary.actionItems} /> : null}
                        </div>
                    ) : loaded && !busy ? (
                        <p className="mt-4 text-sm text-muted-foreground">No summary yet. Click "Summarize" to generate one.</p>
                    ) : null}

                    {hasSummary && summary ? (
                        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
                            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                                {templateName ? <Chip>{templateName}</Chip> : null}
                                {summary.language ? <Chip>{LANGUAGES.find((l) => l.value === summary.language)?.label ?? summary.language}</Chip> : null}
                                {summary.provider ? <Chip>{summary.provider}</Chip> : null}
                                {summary.model ? <Chip mono>{summary.model}</Chip> : null}
                            </div>
                            <div className="flex flex-wrap items-center gap-1">
                                <Button variant="ghost" size="sm" onClick={() => void navigator.clipboard?.writeText(summaryPlain(exportInput())).then(() => toast.success("Summary copied"), () => toast.error("Could not copy the summary"))}>
                                    <Copy aria-hidden="true" /> Copy
                                </Button>
                                <Button variant="ghost" size="sm" aria-label="Download summary as Markdown" onClick={() => downloadText(`${base}.md`, "text/markdown", summaryMarkdown(exportInput()))}>
                                    <Download aria-hidden="true" /> Markdown
                                </Button>
                                <Button variant="ghost" size="sm" aria-label="Download summary as TXT" onClick={() => downloadText(`${base}.txt`, "text/plain", summaryPlain(exportInput()))}>
                                    <Download aria-hidden="true" /> TXT
                                </Button>
                                <Button variant="ghost" size="sm" className="text-destructive" aria-label="Delete summary" disabled={busy} onClick={() => void remove()}>
                                    <Trash2 aria-hidden="true" /> Delete
                                </Button>
                            </div>
                        </div>
                    ) : null}
                </>
            )}
        </Card>
    );
}

/** A summary the pane can show: text, key points or action items. */
export function hasSummaryContent(data: SummaryData | null): boolean {
    if (!data) return false;
    return Boolean(data.summary?.trim()) || Boolean(data.keyPoints?.length) || Boolean(data.actionItems?.length);
}

function Chip({ children, mono = false }: { children: ReactNode; mono?: boolean }) {
    return <span className={cn("rounded bg-muted px-2 py-0.5", mono && "font-mono")}>{children}</span>;
}

/** Summary text: "#" lines as headings, "-" or "*" lines as bullets, the rest as paragraphs. */
function Formatted({ text }: { text: string }) {
    const blocks: ReactNode[] = [];
    let bullets: string[] = [];
    const flush = () => {
        if (bullets.length) {
            blocks.push(
                <ul key={`ul-${blocks.length}`} className="space-y-1">
                    {bullets.map((b, i) => (
                        <BulletItem key={i}>{b}</BulletItem>
                    ))}
                </ul>,
            );
            bullets = [];
        }
    };
    for (const raw of text.split("\n")) {
        const line = raw.trim();
        const bullet = /^[-*]\s+(.*)$/.exec(line);
        if (bullet) {
            bullets.push(bullet[1]);
            continue;
        }
        flush();
        if (!line) continue;
        const heading = /^#{1,6}\s*(.*)$/.exec(line);
        if (heading) blocks.push(<h4 key={`h-${blocks.length}`} className="mb-2 text-[13px] font-semibold">{heading[1]}</h4>);
        else blocks.push(<p key={`p-${blocks.length}`} className="my-2 leading-relaxed">{line}</p>);
    }
    flush();
    return <>{blocks}</>;
}

function BulletItem({ children }: { children: ReactNode }) {
    return (
        <li className="flex items-start gap-2 text-sm leading-6">
            <span aria-hidden="true" className="mt-2.5 size-1.5 shrink-0 rounded-full bg-primary" />
            <span className="min-w-0">{children}</span>
        </li>
    );
}

function ListSection({ title, items }: { title: string; items: string[] }) {
    return (
        <div>
            <h4 className="mb-2 text-[13px] font-semibold">{title}</h4>
            <ul className="space-y-1">
                {items.map((item, i) => (
                    <BulletItem key={i}>{item}</BulletItem>
                ))}
            </ul>
        </div>
    );
}

function ActionSection({ items }: { items: string[] }) {
    return (
        <div>
            <h4 className="mb-2 text-[13px] font-semibold">Action Items</h4>
            <ul className="space-y-1">
                {items.map((item, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm leading-6">
                        <ListChecks aria-hidden="true" className="mt-1 size-4 shrink-0 text-primary" />
                        <span className="min-w-0">{item}</span>
                    </li>
                ))}
            </ul>
        </div>
    );
}
