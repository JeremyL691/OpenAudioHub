import Link from "next/link";
import { ProgressBar } from "@/components/app/progress-bar";
import { StatusBadge } from "@/components/app/status-badge";
import type { ProcessingItem } from "@/components/overview/overview-view";
import { pipelinePhaseStatus } from "@/lib/recordings/transcript-status";

/** Pipeline jobs that are still running, with their phase and progress. */
export function ProcessingCard({ items }: { items: ProcessingItem[] }) {
    return (
        <section aria-labelledby="processing-heading">
            <h2
                id="processing-heading"
                className="mb-2 text-[13px] font-semibold text-muted-foreground"
            >
                Processing
            </h2>
            {items.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                    Nothing is processing right now.
                </p>
            ) : (
                <ul className="space-y-2">
                    {items.map((item) => (
                        <li
                            key={item.id}
                            className="flex items-center gap-3 rounded-xl bg-muted/60 px-4 py-3 dark:bg-muted"
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
                            <StatusBadge
                                status={pipelinePhaseStatus(item.phase)}
                            />
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}
