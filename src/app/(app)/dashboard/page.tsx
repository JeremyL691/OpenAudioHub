import { redirect } from "next/navigation";
import { OverviewView } from "@/components/overview/overview-view";
import { isSettingsSection } from "@/components/settings-nav-config";
import {
    getActivePipelineJobs,
    getOverviewTotals,
    getPlaudStatus,
    getRecentRecordings,
    getRecordingFlags,
} from "@/db/queries/overview";
import { listUserProviders } from "@/lib/ai/list-providers";
import { requireAuth } from "@/lib/auth-server";
import { decryptText } from "@/lib/encryption/fields";
import { serializeRecording } from "@/types/recording";

interface DashboardPageProps {
    searchParams: Promise<{ settings?: string | string[] }>;
}

/**
 * `/dashboard` is the overview. `?settings=<section>` still forwards to that
 * settings section (D-136). That mapping came from the onboarding link.
 */
export default async function DashboardPage({
    searchParams,
}: DashboardPageProps) {
    const { settings } = await searchParams;
    const section = typeof settings === "string" ? settings : null;
    if (isSettingsSection(section)) redirect(`/settings/${section}`);

    const session = await requireAuth();
    const userId = session.user.id;

    const [totals, jobs, recent, plaud, providers] = await Promise.all([
        getOverviewTotals(userId),
        getActivePipelineJobs(userId),
        getRecentRecordings(userId, 8),
        getPlaudStatus(userId),
        listUserProviders(userId),
    ]);
    const flags = await getRecordingFlags(
        userId,
        recent.map((row) => row.id),
    );

    // Content fields are encrypted at rest; decrypt before the names reach
    // the client. Legacy plaintext rows pass through verbatim.
    const recentRecordings = recent.map((row) =>
        serializeRecording(
            { ...row, filename: decryptText(row.filename) },
            {
                hasTranscript: flags.transcribed.has(row.id),
                hasSummary: flags.summarized.has(row.id),
            },
        ),
    );
    const processing = jobs.map((job) => ({
        id: job.id,
        recordingId: job.recordingId,
        phase: job.phase,
        progress: job.progress,
        title: decryptText(job.filename),
    }));

    return (
        <OverviewView
            totals={totals}
            processing={processing}
            recent={recentRecordings}
            plaud={plaud}
            hasProvider={providers.length > 0}
        />
    );
}
