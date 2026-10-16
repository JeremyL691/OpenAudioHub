import Link from "next/link";
import { statusLabel } from "@/components/app/status-badge";
import { formatHoursCompact } from "@/lib/format-duration";
import { pipelinePhaseStatus } from "@/lib/recordings/transcript-status";

interface AtAGlanceProps {
    weekCount: number;
    weekMs: number;
    untranscribed: number;
    processingCount: number;
    firstProcessing: { title: string; phase: string } | null;
}

function Tile({
    href,
    label,
    value,
    hint,
}: {
    href: string;
    label: string;
    value: number;
    hint: string;
}) {
    return (
        <Link
            href={href}
            className="flex min-w-0 flex-col gap-1 rounded-2xl bg-card p-4 shadow-card outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
            <span className="text-[13px] text-muted-foreground">{label}</span>
            <span className="text-[28px] font-semibold leading-tight tracking-tight tabular-nums">
                {value}
            </span>
            <span className="truncate text-xs text-muted-foreground">
                {hint}
            </span>
        </Link>
    );
}

/** The three figures at the top of the dashboard, each linking to its list. */
export function AtAGlance({
    weekCount,
    weekMs,
    untranscribed,
    processingCount,
    firstProcessing,
}: AtAGlanceProps) {
    return (
        <section aria-label="At a glance" className="grid gap-3 sm:grid-cols-3">
            <Tile
                href="/recordings?collection=recent"
                label="Last 7 days"
                value={weekCount}
                hint={
                    weekCount === 0
                        ? "Nothing recorded"
                        : `${formatHoursCompact(weekMs)} recorded`
                }
            />
            <Tile
                href="/recordings?filter=untranscribed"
                label="Not transcribed"
                value={untranscribed}
                hint={untranscribed > 0 ? "Review" : "All transcribed"}
            />
            <Tile
                href="/recordings?filter=processing"
                label="Processing"
                value={processingCount}
                hint={
                    firstProcessing
                        ? `${firstProcessing.title} · ${statusLabel(pipelinePhaseStatus(firstProcessing.phase))}`
                        : "Nothing running"
                }
            />
        </section>
    );
}
