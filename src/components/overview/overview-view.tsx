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
            <div className="container mx-auto max-w-4xl space-y-6 px-4 py-10">
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
        <div className="container mx-auto max-w-6xl space-y-6 px-4 py-6">
            <h1 className="sr-only">Overview</h1>

            <section
                aria-label="Totals"
                className="grid grid-cols-2 gap-4 lg:grid-cols-4"
            >
                <StatCard
                    label="Recordings"
                    value={totals.total}
                    icon={AudioLines}
                />
                <StatCard
                    label="Total time"
                    value={formatHoursCompact(totals.totalMs)}
                    icon={Clock}
                />
                <StatCard
                    label="Transcribed"
                    value={`${transcribedPct}%`}
                    hint={`${totals.transcribed} of ${totals.total}`}
                    icon={FileText}
                />
                <StatCard
                    label="Summarized"
                    value={totals.summarized}
                    icon={Sparkles}
                />
            </section>

            <div className="grid gap-6 lg:grid-cols-3">
                <div className="space-y-6 lg:col-span-2">
                    <ProcessingCard items={processing} />
                    <RecentRecordings items={recent} />
                </div>
                <div className="space-y-6">
                    <OverviewSyncCard plaud={plaud} />
                    <section
                        aria-labelledby="quick-actions-heading"
                        className="space-y-3 rounded-xl border bg-card p-5"
                    >
                        <h2
                            id="quick-actions-heading"
                            className="text-sm font-semibold"
                        >
                            Quick actions
                        </h2>
                        <OverviewActions hasProvider={hasProvider} />
                    </section>
                </div>
            </div>
        </div>
    );
}
