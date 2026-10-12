import Link from "next/link";
import { StatusBadge } from "@/components/app/status-badge";
import { Button } from "@/components/ui/button";
import { formatDurationMs } from "@/lib/format-duration";
import { transcriptStatus } from "@/lib/recordings/transcript-status";
import type { Recording } from "@/types/recording";

/** The newest recordings, each linking to its place in the library. */
export function RecentRecordings({ items }: { items: Recording[] }) {
    return (
        <section aria-labelledby="recent-heading">
            <div className="mb-2 flex items-end justify-between gap-2">
                <h2
                    id="recent-heading"
                    className="text-[13px] font-semibold text-muted-foreground"
                >
                    Recent recordings
                </h2>
                <Button
                    asChild
                    variant="ghost"
                    size="sm"
                    className="text-link font-medium"
                >
                    <Link href="/recordings">View all</Link>
                </Button>
            </div>
            <ul>
                {items.map((recording) => (
                    <li key={recording.id}>
                        <Link
                            href={`/recordings?id=${recording.id}`}
                            className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-4 border-b border-border py-2.5 transition-colors hover:bg-accent/40"
                        >
                            <span className="min-w-0 truncate text-sm font-medium">
                                {recording.filename}
                            </span>
                            <span className="shrink-0 text-[13px] tabular-nums text-muted-foreground">
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
