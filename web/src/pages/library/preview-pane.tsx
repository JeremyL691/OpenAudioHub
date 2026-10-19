import { Link } from "react-router";
import { ArrowUpRight, ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RecordingDetail } from "@/components/recording/recording-detail";
import { useI18n } from "@/lib/i18n";

export interface PreviewPaneProps {
    id: string;
    /** Returns to the list. Shown only below the lg breakpoint, where the panes take turns. */
    onBack(): void;
}

/** The detail pane beside the library list. The detail content itself comes from RecordingDetail. */
export function PreviewPane({ id, onBack }: PreviewPaneProps) {
    const { t } = useI18n();
    return (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto lg:overflow-hidden">
            <div className="flex items-center gap-2 px-4 pt-3 lg:hidden">
                <Button variant="ghost" className="-ml-2 h-9 gap-1 px-2" onClick={onBack}>
                    <ChevronLeft />
                    {t("library.backToRecordings")}
                </Button>
            </div>
            <div className="flex justify-end px-4 pt-3 lg:shrink-0 lg:px-8 lg:pt-6 lg:pb-3">
                <Button asChild variant="ghost" size="sm" className="h-8 gap-1 px-2" data-testid="open-full-view">
                    <Link to={`/recordings/${encodeURIComponent(id)}`}>
                        {t("library.openFullView")}
                        <ArrowUpRight />
                    </Link>
                </Button>
            </div>
            <RecordingDetail id={id} variant="pane" />
        </div>
    );
}
