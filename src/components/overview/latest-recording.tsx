import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { MiniWaveform } from "@/components/app/mini-waveform";
import { LocalTime } from "@/components/local-time";
import { Button } from "@/components/ui/button";
import { formatDurationMs } from "@/lib/format-duration";
import { recordingSource } from "@/lib/recordings/transcript-status";
import type { Recording } from "@/types/recording";

/** The newest recording, with its waveform and a link to open it. */
export function LatestRecording({ recording }: { recording: Recording }) {
    return (
        <section
            aria-labelledby="latest-heading"
            className="space-y-4 rounded-2xl bg-card p-5 shadow-card"
        >
            <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 space-y-1">
                    <h2
                        id="latest-heading"
                        className="text-xs font-medium text-muted-foreground"
                    >
                        Latest recording
                    </h2>
                    <p className="truncate text-[17px] font-semibold">
                        {recording.filename}
                    </p>
                    <p className="text-xs text-muted-foreground tabular-nums">
                        <LocalTime value={recording.startTime} variant="date" />
                        {` · ${recordingSource(recording.deviceSn)} · ${formatDurationMs(recording.duration)}`}
                    </p>
                </div>
                <Button
                    asChild
                    size="icon"
                    aria-label={`Open ${recording.filename}`}
                    className="shrink-0 rounded-full"
                >
                    <Link href={`/recordings/${recording.id}`}>
                        <ArrowRight />
                    </Link>
                </Button>
            </div>
            {recording.waveformPeaks ? (
                <MiniWaveform
                    peaks={recording.waveformPeaks}
                    bars={96}
                    className="h-14 w-full"
                />
            ) : null}
        </section>
    );
}
