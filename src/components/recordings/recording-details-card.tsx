"use client";

import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { LocalTime } from "@/components/local-time";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/format-bytes";
import { formatDurationMs } from "@/lib/format-duration";
import { estimateMp3Bytes } from "@/lib/recordings/mp3-estimate";
import type { Recording } from "@/types/recording";

const PANEL_ID = "recording-details-panel";

/** The recording's metadata as a grouped list. The list collapses under its heading. */
export function RecordingDetailsCard({ recording }: { recording: Recording }) {
    const [open, setOpen] = useState(true);

    return (
        <section className="space-y-2">
            <div className="flex items-center justify-between gap-2">
                <h3 className="text-[13px] font-semibold">Details</h3>
                <Button
                    variant="ghost"
                    size="sm"
                    aria-expanded={open}
                    aria-controls={PANEL_ID}
                    onClick={() => setOpen((current) => !current)}
                >
                    {open ? "Collapse" : "Expand"}
                    <ChevronDown
                        className={`size-4 transition-transform ${open ? "rotate-180" : ""}`}
                        aria-hidden="true"
                    />
                </Button>
            </div>
            <div
                id={PANEL_ID}
                hidden={!open}
                className="divide-y divide-border overflow-hidden rounded-xl bg-muted text-[13px]"
            >
                <div className="flex min-h-11 items-center justify-between gap-6 px-4 py-2.5">
                    <span className="text-muted-foreground">Duration</span>
                    <span className="font-medium tabular-nums">
                        {formatDurationMs(recording.duration)}
                    </span>
                </div>
                <div className="flex min-h-11 items-center justify-between gap-6 px-4 py-2.5">
                    <span className="text-muted-foreground">File Size</span>
                    <span className="text-right font-medium tabular-nums">
                        {formatBytes(recording.filesize)} original · MP3 ≈{" "}
                        {formatBytes(estimateMp3Bytes(recording.duration))}
                    </span>
                </div>
                <div className="flex min-h-11 items-center justify-between gap-6 px-4 py-2.5">
                    <span className="text-muted-foreground">Device</span>
                    <span className="min-w-0 truncate font-mono text-xs">
                        {recording.deviceSn ?? "Upload"}
                    </span>
                </div>
                <div className="flex min-h-11 items-center justify-between gap-6 px-4 py-2.5">
                    <span className="text-muted-foreground">Date</span>
                    <span className="font-medium">
                        <LocalTime value={recording.startTime} variant="date" />
                    </span>
                </div>
            </div>
        </section>
    );
}
