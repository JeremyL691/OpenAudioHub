import { AudioLines, Clock, FileText, Sparkles } from "lucide-react";
import { EmptyState } from "@/components/app/empty-state";
import { StatCard } from "@/components/app/stat-card";
import { OverviewActions } from "@/components/overview/overview-actions";
import { ProcessingCard } from "@/components/overview/processing-card";
import { RecentRecordings } from "@/components/overview/recent-recordings";
import { OverviewSyncCard } from "@/components/overview/sync-card";
import type { PlaudStatus } from "@/db/queries/overview";
import { formatHoursCompact } from "@/lib/format-duration";
import type { Recording } from "@/types/recording";

export interface ProcessingItem {
    id: string;
    recordingId: string;
    phase: string;
    progress: number;
    title: string;
}

export interface OverviewTotals {
    total: number;
    totalMs: number;
    transcribed: number;
    summarized: number;
}

interface OverviewViewProps {
    totals: OverviewTotals;
    processing: ProcessingItem[];
    recent: Recording[];
    plaud: PlaudStatus;
    hasProvider: boolean;
}

const totalCell =
    "min-w-0 px-5 first:pl-0 border-border max-lg:odd:pl-0 max-lg:odd:border-r lg:border-r lg:last:border-r-0 max-lg:[&:nth-child(n+3)]:border-t";

/**
 * The signed-in home page. Server-rendered: the figures and lists come from the
 * overview queries. Only the sync card and the actions are client components.
 */
export function OverviewView({
    totals,
    processing,
    recent,
    plaud,
    hasProvider,
}: OverviewViewProps) {
    if (totals.total === 0) {
        return (
            <div className="mx-auto max-w-5xl space-y-6 px-6 py-8 lg:px-9">
                <h1 className="sr-only">Overview</h1>
                <EmptyState
                    icon={AudioLines}
                    title="No recordings yet"
                    description="Sync from your Plaud account, or upload an audio file to start your library."
                    action={
                        <OverviewActions
                            hasProvider={hasProvider}
                            includeSync
                        />
                    }
                />
            </div>
        );
    }

    const transcribedPct = Math.round(
        (totals.transcribed / totals.total) * 100,
    );

    return (
        <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-9">
            <h1 className="sr-only">Overview</h1>

            <section
                aria-label="Totals"
                className="grid grid-cols-2 border-y border-border lg:grid-cols-4"
            >
                <StatCard
                    label="Recordings"
                    value={totals.total}
                    icon={AudioLines}
                    className={totalCell}
                />
                <StatCard
                    label="Total time"
                    value={formatHoursCompact(totals.totalMs)}
                    icon={Clock}
                    className={totalCell}
                />
                <StatCard
                    label="Transcribed"
                    value={`${transcribedPct}%`}
                    hint={`${totals.transcribed} of ${totals.total}`}
                    icon={FileText}
                    className={totalCell}
                />
                <StatCard
                    label="Summarized"
                    value={totals.summarized}
                    icon={Sparkles}
                    className={totalCell}
                />
            </section>

            <div className="mt-9 grid grid-cols-1 gap-9 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
                <div className="min-w-0 space-y-9">
                    <ProcessingCard items={processing} />
                    <RecentRecordings items={recent} />
                </div>
                <div className="min-w-0 space-y-9">
                    <OverviewSyncCard plaud={plaud} />
                    <section aria-labelledby="quick-actions-heading">
                        <h2
                            id="quick-actions-heading"
                            className="mb-2 text-[13px] font-semibold text-muted-foreground"
                        >
                            Quick actions
                        </h2>
                        <div className="overflow-hidden rounded-xl bg-muted/60 dark:bg-muted [&>div]:flex [&>div]:flex-col [&>div]:items-stretch [&>div]:justify-start [&>div]:gap-0 [&>div]:divide-y [&>div]:divide-border [&_a]:h-11 [&_a]:w-full [&_a]:justify-start [&_a]:gap-2.5 [&_a]:rounded-none [&_a]:border-0 [&_a]:bg-transparent [&_a]:px-4 [&_a]:shadow-none [&_a]:hover:bg-accent [&_button]:h-11 [&_button]:w-full [&_button]:justify-start [&_button]:gap-2.5 [&_button]:rounded-none [&_button]:border-0 [&_button]:bg-transparent [&_button]:px-4 [&_button]:shadow-none [&_button]:hover:bg-accent">
                            <OverviewActions hasProvider={hasProvider} />
                        </div>
                    </section>
                </div>
            </div>
        </div>
    );
}
