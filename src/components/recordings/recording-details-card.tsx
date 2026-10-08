"use client";

import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { LocalTime } from "@/components/local-time";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatBytes } from "@/lib/format-bytes";
import { formatDurationMs } from "@/lib/format-duration";
import type { Recording } from "@/types/recording";

const PANEL_ID = "recording-details-panel";

/** The recording's metadata. The card collapses to its header. */
export function RecordingDetailsCard({ recording }: { recording: Recording }) {
    const [open, setOpen] = useState(true);

    return (
        <Card>
            <CardHeader>
                <div className="flex items-center justify-between gap-2">
                    <CardTitle>Details</CardTitle>
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
            </CardHeader>
            <CardContent id={PANEL_ID} hidden={!open}>
                <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                        <div className="mb-1 text-xs text-muted-foreground">
                            Duration
                        </div>
                        <div className="font-medium">
                            {formatDurationMs(recording.duration)}
                        </div>
                    </div>
                    <div>
                        <div className="mb-1 text-xs text-muted-foreground">
                            File Size
                        </div>
                        <div className="font-medium">
                            {formatBytes(recording.filesize)}
                        </div>
                    </div>
                    <div>
                        <div className="mb-1 text-xs text-muted-foreground">
                            Device
                        </div>
                        <div className="truncate font-mono text-xs">
                            {recording.deviceSn ?? "Upload"}
                        </div>
                    </div>
                    <div>
                        <div className="mb-1 text-xs text-muted-foreground">
                            Date
                        </div>
                        <div className="font-medium">
                            <LocalTime
                                value={recording.startTime}
                                variant="date"
                            />
                        </div>
                    </div>
                </div>
            </CardContent>
        </Card>
    );
}
