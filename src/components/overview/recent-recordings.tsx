import Link from "next/link";
import { MiniWaveform } from "@/components/app/mini-waveform";
import { StatusBadge } from "@/components/app/status-badge";
import { LocalTime } from "@/components/local-time";
import { formatDurationMs } from "@/lib/format-duration";
import {
    recordingSource,
    transcriptStatus,
} from "@/lib/recordings/transcript-status";
import type { Recording } from "@/types/recording";

/** The newest recordings as one grouped list, each linking to its place in the library. */
export function RecentRecordings({ items }: { items: Recording[] }) {
    return (
        <section aria-label="Recent recordings" className="space-y-2.5">
            <div className="flex items-end justify-between gap-2">
                <h2 className="text-[17px] font-semibold">Recent</h2>
                <Link
                    href="/recordings"
                    className="text-sm font-medium text-link"
                >
                    Show all
                </Link>
            </div>
            <ul className="divide-y divide-border overflow-hidden rounded-xl bg-muted">
                {items.map((recording) => (
                    <li key={recording.id}>
                        <Link
                            href={`/recordings?id=${recording.id}`}
                            className="flex min-h-11 items-center gap-3 px-4 py-2.5 transition-colors hover:bg-accent"
                        >
                            <MiniWaveform
                                peaks={recording.waveformPeaks}
                                bars={16}
                                className="w-14 shrink-0"
                            />
                            <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm font-medium">
                                    {recording.filename}
                                </span>
                                <span className="block truncate text-xs text-muted-foreground tabular-nums">
                                    {recordingSource(recording.deviceSn)}
                                    {" · "}
                                    <LocalTime value={recording.startTime} />
                                </span>
                            </span>
                            <StatusBadge
                                status={transcriptStatus(recording)}
                                className="hidden sm:inline-flex"
                            />
                            <span className="shrink-0 text-[13px] tabular-nums text-muted-foreground">
                                {formatDurationMs(recording.duration)}
                            </span>
                        </Link>
                    </li>
                ))}
            </ul>
        </section>
    );
}
