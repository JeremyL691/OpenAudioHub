import Link from "next/link";
import {
    StatusBadge,
    type StatusBadgeStatus,
} from "@/components/app/status-badge";
import { Button } from "@/components/ui/button";
import { formatDurationMs } from "@/lib/format-duration";
import type { Recording } from "@/types/recording";

function transcriptStatus(recording: Recording): StatusBadgeStatus {
    if (recording.hasSummary) return "summary_ready";
    if (recording.hasTranscript) return "transcript_ready";
    return "transcript_missing";
}

/** The newest recordings, each linking to its place in the library. */
export function RecentRecordings({ items }: { items: Recording[] }) {
    return (
        <section
            aria-labelledby="recent-heading"
            className="rounded-xl border bg-card p-5"
        >
            <div className="flex items-center justify-between gap-2">
                <h2 id="recent-heading" className="text-sm font-semibold">
                    Recent recordings
                </h2>
                <Button asChild variant="ghost" size="sm">
                    <Link href="/recordings">View all</Link>
                </Button>
            </div>
            <ul className="mt-3 divide-y">
                {items.map((recording) => (
                    <li key={recording.id}>
                        <Link
                            href={`/recordings?id=${recording.id}`}
                            className="flex items-center gap-3 rounded-md py-3 transition-colors hover:bg-accent/40"
                        >
                            <span className="min-w-0 flex-1 truncate text-sm font-medium">
                                {recording.filename}
                            </span>
                            <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                                {formatDurationMs(recording.duration)}
                            </span>
                            <StatusBadge status={transcriptStatus(recording)} />
                        </Link>
                    </li>
                ))}
            </ul>
        </section>
    );
}
