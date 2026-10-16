import { AudioLines } from "lucide-react";
import { EmptyState } from "@/components/app/empty-state";
import { AtAGlance } from "@/components/overview/at-a-glance";
import { LatestRecording } from "@/components/overview/latest-recording";
import { OverviewActions } from "@/components/overview/overview-actions";
import { OverviewHeader } from "@/components/overview/overview-header";
import { RecentRecordings } from "@/components/overview/recent-recordings";
import { SetupChecklist } from "@/components/overview/setup-checklist";
import type { PlaudStatus } from "@/db/queries/overview";
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

export interface RecentWindowTotals {
    count: number;
    totalMs: number;
}

interface OverviewViewProps {
    totals: OverviewTotals;
    recentWindow: RecentWindowTotals;
    processing: ProcessingItem[];
    recent: Recording[];
    plaud: PlaudStatus;
    hasProvider: boolean;
}

/**
 * The signed-in home page. Server-rendered: the figures and lists come from the
 * overview queries. Only the header and the actions are client components.
 */
export function OverviewView({
    totals,
    recentWindow,
    processing,
    recent,
    plaud,
    hasProvider,
}: OverviewViewProps) {
    const setup = (
        <SetupChecklist
            plaudConnected={plaud.connected}
            hasProvider={hasProvider}
        />
    );

    if (totals.total === 0) {
        return (
            <div className="mx-auto w-full max-w-5xl space-y-7 px-4 py-7 sm:px-8">
                <OverviewHeader plaud={plaud} />
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
                {setup}
            </div>
        );
    }

    const latest = recent[0];

    return (
        <div className="mx-auto w-full max-w-5xl space-y-7 px-4 py-7 sm:px-8">
            <OverviewHeader plaud={plaud} />
            <AtAGlance
                weekCount={recentWindow.count}
                weekMs={recentWindow.totalMs}
                untranscribed={Math.max(0, totals.total - totals.transcribed)}
                processingCount={processing.length}
                firstProcessing={processing[0] ?? null}
            />
            {latest ? <LatestRecording recording={latest} /> : null}
            <RecentRecordings items={recent} />
            {setup}
        </div>
    );
}
