import Link from "next/link";
import { ProgressBar } from "@/components/app/progress-bar";
import {
    STATUS_BADGE_STATUSES,
    StatusBadge,
    type StatusBadgeStatus,
} from "@/components/app/status-badge";
import type { ProcessingItem } from "@/components/overview/overview-view";

function badgeFor(phase: string): StatusBadgeStatus {
    return (STATUS_BADGE_STATUSES as readonly string[]).includes(phase)
        ? (phase as StatusBadgeStatus)
        : "running";
}

/** Pipeline jobs that are still running, with their phase and progress. */
export function ProcessingCard({ items }: { items: ProcessingItem[] }) {
    return (
        <section
            aria-labelledby="processing-heading"
            className="rounded-xl border bg-card p-5"
        >
            <h2 id="processing-heading" className="text-sm font-semibold">
                Processing
            </h2>
            {items.length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">
                    Nothing is processing right now.
                </p>
            ) : (
                <ul className="mt-3 divide-y">
                    {items.map((item) => (
                        <li
                            key={item.id}
                            className="flex items-center gap-3 py-3"
                        >
                            <div className="min-w-0 flex-1 space-y-2">
                                <Link
                                    href={`/recordings/${item.recordingId}`}
                                    className="block truncate text-sm font-medium hover:underline"
                                >
                                    {item.title}
                                </Link>
                                <ProgressBar
                                    value={item.progress}
                                    label={`${item.title} progress`}
                                />
                            </div>
                            <StatusBadge status={badgeFor(item.phase)} />
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}
