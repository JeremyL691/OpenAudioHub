import { Fragment, type ReactNode, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";
import type { Recording } from "@/lib/recordings";
import type { PendingUpload } from "./uploads";
import { groupSummary, type RowGroup } from "./library-model";
import type { LoadStatus } from "./hooks";
import { useI18n } from "@/lib/i18n";

export interface RecordingListProps {
    /** The sticky header, rendered inside the scroll container. */
    header: ReactNode;
    className?: string;
    status: LoadStatus;
    error: string | null;
    onRetry(): void;
    groups: RowGroup[];
    /** Day headings are shown only when the list is sorted by date. */
    showHeadings: boolean;
    pending: PendingUpload[];
    emptyText: string | null;
    /** Whether the search box is waiting for an answer, has an answer, or could not get one. */
    searchStatus?: "idle" | "searching" | "ready" | "error";
    onSearchRetry?(): void;
    renderRow(recording: Recording): ReactNode;
    /** More rows exist than are shown. */
    hasMore: boolean;
    /** Called when the end marker comes into view. */
    onNeedMore(): void;
}

/**
 * The list pane. It is the scroll container itself, so the end marker can use it as
 * the observer root. The end marker is observed again after every change to the row
 * count, so a page keeps loading while the marker stays in view.
 */
export function RecordingList(props: RecordingListProps) {
    const { t } = useI18n();
    const { groups, hasMore } = props;
    const root = useRef<HTMLDivElement>(null);
    const marker = useRef<HTMLDivElement>(null);
    const needMore = useRef(props.onNeedMore);

    useEffect(() => {
        needMore.current = props.onNeedMore;
    }, [props.onNeedMore]);

    const rowCount = groups.reduce((total, g) => total + g.rows.length, 0);

    useEffect(() => {
        const rootEl = root.current;
        const target = marker.current;
        if (!rootEl || !target || !hasMore) return;
        // A fresh observer reports the current position of the marker at once, so a
        // marker that is still in view after a page loads asks for the next page too.
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) needMore.current();
            },
            { root: rootEl, rootMargin: "200px 0px" },
        );
        observer.observe(target);
        return () => observer.disconnect();
    }, [hasMore, rowCount]);

    return (
        <div
            ref={root}
            data-testid="recording-list"
            className={cn("min-h-0 flex-col overflow-y-auto overscroll-contain bg-background", props.className)}
        >
            {props.header}

            <div className="flex flex-col pb-6">
                {props.status === "loading" ? (
                    <div className="flex justify-center py-8">
                        <Spinner label={t("library.loading")} />
                    </div>
                ) : null}

                {props.status === "error" ? (
                    <div className="flex flex-col items-center gap-3 px-4 py-8 text-center">
                        <p className="text-sm text-muted-foreground" role="alert">
                            {props.error ?? t("library.loadError")}
                        </p>
                        <Button variant="secondary" size="sm" onClick={props.onRetry}>
                            {t("library.tryAgain")}
                        </Button>
                    </div>
                ) : null}

                {props.pending.map((upload) => (
                    <div key={upload.key} className="mx-2 flex items-center gap-3 rounded-lg px-3 py-3 text-sm text-muted-foreground">
                        <Spinner label={t("library.uploadingProgress", { name: upload.name })} />
                        <span className="min-w-0 truncate">{upload.name}</span>
                    </div>
                ))}

                {groups.map((group) => (
                    <section key={group.key} className="flex flex-col">
                        {props.showHeadings ? (
                            <div className="sticky top-0 z-10 flex items-baseline gap-2 bg-background/85 px-4 pt-3 pb-1 backdrop-blur supports-[backdrop-filter]:bg-background/60 lg:static">
                                <h3 className="text-[13px] font-semibold text-foreground">{group.label}</h3>
                                <p className="text-xs tabular-nums text-muted-foreground">{groupSummary(group.rows.length, group.totalMs)}</p>
                            </div>
                        ) : null}
                        <div className="flex flex-col gap-0.5 px-2">
                            {group.rows.map((recording) => (
                                <Fragment key={recording.id}>{props.renderRow(recording)}</Fragment>
                            ))}
                        </div>
                    </section>
                ))}

                {props.emptyText && props.status === "ready" ? (
                    // A search that is running or that failed gets its own state, with a way to
                    // ask again: an incomplete answer must not read as "nothing matches".
                    <div className="flex flex-col items-center gap-3 px-4 py-8" role="status" aria-live="polite">
                        <p className="text-center text-sm text-muted-foreground">{props.emptyText}</p>
                        {props.searchStatus === "searching" ? <Spinner /> : null}
                        {props.searchStatus === "error" && props.onSearchRetry ? (
                            <Button variant="outline" size="sm" onClick={props.onSearchRetry}>
                                {t("library.retry")}
                            </Button>
                        ) : null}
                    </div>
                ) : null}

                {hasMore ? <div ref={marker} aria-hidden="true" className="h-px" /> : null}
            </div>
        </div>
    );
}
