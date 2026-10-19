import { type ReactNode, useState } from "react";
import { ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatBytes, formatClock } from "@/lib/format";
import type { Recording } from "@/lib/recordings";
import { intlLocale, t, useI18n } from "@/lib/i18n";

/** Read-only facts about the recording file */
export function DetailsCard({ recording }: { recording: Recording }) {
    const { t } = useI18n();
    const [expanded, setExpanded] = useState(true);
    const date = new Date(recording.startTime).toLocaleDateString(intlLocale());
    const rows: [string, ReactNode][] = [
        [t("recording.details.duration"), formatClock(recording.duration / 1000)],
        [t("recording.details.fileSize"), fileSize(recording)],
        [t("recording.details.device"), <span className="font-mono">{recording.deviceSn}</span>],
        [t("recording.details.date"), date],
    ];
    return (
        <section className="grid content-start gap-2" data-testid="details-card">
            <div className="flex items-center justify-between gap-2">
                <h3 className="text-[13px] font-semibold">{t("recording.tabs.details")}</h3>
                <Button variant="ghost" size="sm" aria-expanded={expanded} aria-controls={`recording-details-${recording.id}`} onClick={() => setExpanded((v) => !v)}>
                    {expanded ? t("recording.details.collapse") : t("recording.details.expand")}
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
    return t("recording.details.fileSizeValue", { original: formatBytes(recording.filesize), mp3: formatBytes(mp3) });
}
