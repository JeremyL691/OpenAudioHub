import { type ReactNode, useState } from "react";
import { ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatBytes, formatClock } from "@/lib/format";
import type { Recording } from "@/lib/recordings";

/** Read-only facts about the recording file */
export function DetailsCard({ recording }: { recording: Recording }) {
    const [expanded, setExpanded] = useState(true);
    const date = new Date(recording.startTime).toLocaleDateString("en-US");
    const rows: [string, ReactNode][] = [
        ["Duration", formatClock(recording.duration / 1000)],
        ["File Size", fileSize(recording)],
        ["Device", <span className="font-mono">{recording.deviceSn}</span>],
        ["Date", date],
    ];
    return (
        <section className="grid content-start gap-2" data-testid="details-card">
            <div className="flex items-center justify-between gap-2">
                <h3 className="text-[13px] font-semibold">Details</h3>
                <Button variant="ghost" size="sm" aria-expanded={expanded} aria-controls={`recording-details-${recording.id}`} onClick={() => setExpanded((v) => !v)}>
                    {expanded ? "Collapse" : "Expand"}
                    <ChevronUp aria-hidden="true" className={expanded ? undefined : "rotate-180"} />
                </Button>
            </div>
            <dl id={`recording-details-${recording.id}`} hidden={!expanded} className="divide-y divide-border overflow-hidden rounded-xl bg-muted text-[13px]">
                {rows.map(([term, value]) => (
                    <div key={term} className="flex min-h-11 items-center justify-between gap-6 px-4 py-2.5">
                        <dt className="text-muted-foreground">{term}</dt>
                        <dd className="min-w-0 break-words text-right text-foreground">{value}</dd>
                    </div>
                ))}
            </dl>
        </section>
    );
}

/** "12.31 KB original · MP3 ≈ 48.38 KB": the stored size, and the 128 kbit/s MP3 the export makes. */
function fileSize(recording: Recording): string {
    const mp3 = Math.round((recording.duration / 1000) * (128_000 / 8));
    return `${formatBytes(recording.filesize)} original · MP3 ≈ ${formatBytes(mp3)}`;
}
