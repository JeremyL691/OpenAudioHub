import type { ReactNode } from "react";
import { Link, Navigate, useSearchParams } from "react-router";
import { ArrowRight, ChevronRight, Circle, CircleCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { RecordingStatusBadge } from "@/components/ui/status-badge";
import { recordingStage } from "@/components/recording/pipeline-labels";
import { MiniWaveform } from "@/components/ui/mini-waveform";
import { isRecent, useShellData } from "@/components/shell/shell-data";
import { useUploads } from "@/components/recordings/uploads";
import { formatClock, formatDate, formatDateTime, formatRelative } from "@/lib/format";
import { sourceOf, type Recording } from "@/lib/recordings";

/** Settings sections that a ?settings=<section> link may forward to (spec/ui-app.md 3). */
const SETTINGS_SECTIONS = [
    "providers",
    "transcription",
    "summary",
    "naming",
    "plaud-account",
    "sync",
    "playback",
    "display",
    "storage",
    "export",
];

const RECENT_LIMIT = 8;

const PROCESSING_LABEL: Record<NonNullable<Recording["processing"]>["kind"], string> = {
    transcribe: "Transcribing",
    pipeline: "Processing audio",
    summary: "Writing summary",
};

function sourceLabel(recording: Recording): string {
    return sourceOf(recording) === "plaud" ? "Plaud" : "Upload";
}

/** Recorded time for the "Last 7 days" tile, in whole minutes, for example "0 min" or "2 h 5 min". */
function formatRecordedMinutes(totalSeconds: number): string {
    const minutes = Math.max(0, Math.round(totalSeconds / 60));
    const hours = Math.floor(minutes / 60);
    if (hours > 0) return `${hours} h ${minutes % 60} min`;
    return `${minutes} min`;
}

function newestFirst(recordings: Recording[]): Recording[] {
    return [...recordings].sort((a, b) => Date.parse(b.startTime) - Date.parse(a.startTime));
}

export default function Dashboard() {
    const [params] = useSearchParams();
    const sectionParam = params.get("settings");
    if (sectionParam && SETTINGS_SECTIONS.includes(sectionParam)) return <Navigate to={`/settings/${sectionParam}`} replace />;

    return <DashboardContent />;
}

function DashboardContent() {
    const { recordings, connection, providerCount, sync, syncNow, openUploadPicker } = useShellData();
    const { busy: uploading } = useUploads();
    const connected = Boolean(connection?.connected);
    const needsReconnect = Boolean(connection?.needsReconnect);
    const syncing = sync.status === "syncing";
    const today = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

    return (
        <div className="mx-auto flex w-full max-w-5xl min-w-0 flex-col gap-7 px-4 py-7 sm:px-8">
            <header className="space-y-1">
                <h1 className="text-[28px] font-bold tracking-tight">Dashboard</h1>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                    <span>{today}</span>
                    <span aria-hidden="true">·</span>
                    <section aria-label="Plaud sync" className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span>{plaudStatusText(connection, sync.lastSyncAt)}</span>
                        {connected && !needsReconnect ? (
                            <Button data-testid="overview-sync-now" variant="secondary" size="sm" disabled={syncing} onClick={() => void syncNow()}>
                                {syncing ? "Syncing…" : "Sync now"}
                            </Button>
                        ) : null}
                    </section>
                </div>
            </header>

            {needsReconnect ? (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-warning/15 px-4 py-3 text-sm text-foreground">
                    <span>Reconnect Plaud to keep recordings syncing.</span>
                    <Link to="/settings/plaud-account" className="font-medium text-link hover:underline">
                        Reconnect
                    </Link>
                </div>
            ) : null}

            {recordings === null ? (
                <div className="flex justify-center py-12">
                    <Spinner label="Loading recordings" />
                </div>
            ) : recordings.length === 0 ? (
                <div className="flex flex-col gap-7">
                    <EmptyState
                        title="No recordings yet"
                        description="Sync from your Plaud account, or upload an audio file to start your library."
                        action={
                            <>
                                <Button data-testid="overview-upload" variant="primary" disabled={uploading} onClick={openUploadPicker}>
                                    Upload audio
                                </Button>
                                <Button data-testid="overview-sync" variant="secondary" disabled={syncing} onClick={() => void syncNow()}>
                                    {syncing ? "Syncing…" : "Sync now"}
                                </Button>
                                {providerCount === 0 ? (
                                    <Link to="/settings/providers" className="inline-flex h-10 items-center text-sm font-medium text-link hover:underline sm:h-8">
                                        Add an AI provider
                                    </Link>
                                ) : null}
                            </>
                        }
                    />
                    <SetUp plaudDone={connected} providerDone={(providerCount ?? 0) > 0} />
                </div>
            ) : (
                <>
                    <AtAGlance recordings={recordings} />
                    <LatestRecording recording={newestFirst(recordings)[0]} />
                    <RecentRecordings recordings={newestFirst(recordings).slice(0, RECENT_LIMIT)} />
                    <SetUp plaudDone={connected} providerDone={(providerCount ?? 0) > 0} />
                </>
            )}
        </div>
    );
}

function plaudStatusText(connection: { connected: boolean; needsReconnect?: boolean } | null, lastSyncAt: number | null): string {
    if (!connection) return "Checking Plaud…";
    if (!connection.connected) return "Plaud not connected";
    if (connection.needsReconnect) return "Plaud sign-in expired";
    return lastSyncAt ? `Last synced ${formatRelative(lastSyncAt)}` : "Not synced yet";
}

function AtAGlance({ recordings }: { recordings: Recording[] }) {
    const now = Date.now();
    const recent = recordings.filter((r) => isRecent(r, now));
    const recentSeconds = recent.reduce((sum, r) => sum + r.duration / 1000, 0);
    const transcribed = recordings.filter((r) => r.hasTranscript).length;
    const untranscribed = Math.max(0, recordings.length - transcribed);
    const processing = recordings.filter((r) => r.processing !== null);
    const first = processing[0];

    return (
        <section aria-label="At a glance" className="grid gap-3 sm:grid-cols-3">
            <Tile
                to="/recordings?collection=recent"
                label="Last 7 days"
                value={recent.length}
                hint={recent.length === 0 ? "Nothing recorded" : `${formatRecordedMinutes(recentSeconds)} recorded`}
            />
            <Tile
                to="/recordings?filter=untranscribed"
                label="Not transcribed"
                value={untranscribed}
                hint={untranscribed > 0 ? "Review" : "All transcribed"}
            />
            <Tile
                to="/recordings?filter=processing"
                label="Processing"
                value={processing.length}
                hint={first && first.processing ? `${first.filename}, ${PROCESSING_LABEL[first.processing.kind]}` : "Nothing running"}
            />
        </section>
    );
}

function Tile({ to, label, value, hint }: { to: string; label: string; value: number; hint: string }) {
    return (
        <Link
            to={to}
            className="flex min-w-0 flex-col gap-1 rounded-2xl bg-card p-4 text-card-foreground shadow-card outline-none transition-colors duration-150 ease-out motion-reduce:transition-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
            <span className="text-[13px] text-muted-foreground">{label}</span>
            <span className="text-[28px] font-semibold leading-tight tracking-tight tabular-nums">{value}</span>
            <span className="truncate text-xs text-muted-foreground">{hint}</span>
        </Link>
    );
}

function LatestRecording({ recording }: { recording: Recording }) {
    return (
        <section aria-labelledby="latest-recording-heading" className="min-w-0 space-y-4 rounded-2xl bg-card p-5 text-card-foreground shadow-card">
            <div className="flex min-w-0 items-start justify-between gap-4">
                <div className="min-w-0 space-y-1">
                    <h2 id="latest-recording-heading" className="text-xs font-medium text-muted-foreground">
                        Latest recording
                    </h2>
                    <p className="truncate text-[17px] font-semibold">{recording.filename}</p>
                    <p className="text-xs text-muted-foreground tabular-nums">
                        <time dateTime={recording.startTime}>{formatDate(recording.startTime, { year: "numeric", month: "2-digit", day: "2-digit" })}</time>
                        {` · ${sourceLabel(recording)} · ${formatClock(recording.duration / 1000)}`}
                    </p>
                </div>
                <Button asChild variant="primary" size="icon" className="shrink-0 rounded-full sm:size-9">
                    <Link to={`/recordings/${recording.id}`} aria-label={`Open ${recording.filename}`}>
                        <ArrowRight />
                    </Link>
                </Button>
            </div>
            {recording.waveformPeaks && recording.waveformPeaks.length > 0 ? (
                <MiniWaveform peaks={recording.waveformPeaks} bars={96} className="h-14 w-full text-waveform-unplayed" />
            ) : null}
        </section>
    );
}

function RecentRecordings({ recordings }: { recordings: Recording[] }) {
    return (
        <section aria-label="Recent recordings" className="flex min-w-0 flex-col gap-2.5">
            <div className="flex items-end justify-between gap-2">
                <h2 className="text-[17px] font-semibold">Recent</h2>
                <Link to="/recordings" className="inline-flex h-10 items-center text-sm font-medium text-link hover:underline sm:h-8">
                    Show all
                </Link>
            </div>
            <ul className="divide-y divide-border overflow-hidden rounded-xl bg-muted">
                {recordings.map((recording) => (
                    <li key={recording.id}>
                        <Link
                            to={`/recordings?id=${recording.id}`}
                            className="flex min-h-11 min-w-0 items-center gap-3 px-4 py-2.5 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                        >
                            <MiniWaveform peaks={recording.waveformPeaks} bars={16} className="h-6 w-14 shrink-0 text-waveform-unplayed" />
                            <span className="flex min-w-0 flex-1 flex-col">
                                <span className="truncate text-sm font-medium">{recording.filename}</span>
                                <span className="truncate text-xs text-muted-foreground tabular-nums">
                                    {sourceLabel(recording)} · <time dateTime={recording.startTime}>{formatDateTime(recording.startTime)}</time>
                                </span>
                            </span>
                            <RowStatus recording={recording} />
                            <span className="shrink-0 text-[13px] tabular-nums text-muted-foreground">{formatClock(recording.duration / 1000)}</span>
                        </Link>
                    </li>
                ))}
            </ul>
        </section>
    );
}

function RowStatus({ recording }: { recording: Recording }) {
    return <RecordingStatusBadge stage={recordingStage(recording)} className="hidden sm:inline-flex" />;
}

function SetUp({ plaudDone, providerDone }: { plaudDone: boolean; providerDone: boolean }) {
    if (plaudDone && providerDone) return null;
    return (
        <section aria-labelledby="set-up-heading" className="flex flex-col gap-2.5">
            <h2 id="set-up-heading" className="text-[17px] font-semibold">
                Set up
            </h2>
            <ul className="divide-y divide-border overflow-hidden rounded-2xl bg-card shadow-card">
                <SetUpRow done={plaudDone} title="Connect Plaud" to="/settings/plaud-account" />
                <SetUpRow done={providerDone} title="Add an AI provider" to="/settings/providers" />
            </ul>
        </section>
    );
}

function SetUpRow({ done, title, to }: { done: boolean; title: string; to: string }): ReactNode {
    const body = done ? (
        <>
            <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-success" />
            <span className="flex-1">{title}</span>
            <span className="sr-only">Done</span>
        </>
    ) : (
        <>
            <Circle aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            <span className="flex-1">{title}</span>
            <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        </>
    );
    return (
        <li>
            {done ? (
                <div className="flex min-h-11 items-center gap-3 px-4 py-2.5 text-sm text-muted-foreground">{body}</div>
            ) : (
                <Link
                    to={to}
                    className="flex min-h-11 items-center gap-3 px-4 py-2.5 text-sm font-medium transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                    {body}
                </Link>
            )}
        </li>
    );
}
