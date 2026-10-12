"use client";

import { formatDistanceToNow } from "date-fns";
import Link from "next/link";
import { useSyncStatus } from "@/components/app-shell/providers";
import { Button } from "@/components/ui/button";
import type { PlaudStatus } from "@/db/queries/overview";

function relative(date: Date | null): string {
    if (!date) return "Never";
    return formatDistanceToNow(date, { addSuffix: true });
}

/** Plaud connection state, the last and next automatic sync, and Sync now. */
export function OverviewSyncCard({ plaud }: { plaud: PlaudStatus }) {
    const { isAutoSyncing, lastSyncTime, nextSyncTime, manualSync } =
        useSyncStatus();

    const status = !plaud.connected
        ? "Not connected"
        : plaud.needsReconnect
          ? "Reconnect needed"
          : "Connected";

    return (
        <section aria-labelledby="sync-card-heading">
            <h2
                id="sync-card-heading"
                className="mb-2 text-[13px] font-semibold text-muted-foreground"
            >
                Plaud sync
            </h2>
            <div className="divide-y divide-border overflow-hidden rounded-xl bg-muted/60 dark:bg-muted">
                <p className="flex items-center gap-2.5 px-4 py-3 text-sm">
                    <span
                        aria-hidden="true"
                        className={
                            plaud.connected && !plaud.needsReconnect
                                ? "size-2 shrink-0 rounded-full bg-success"
                                : "size-2 shrink-0 rounded-full bg-border"
                        }
                    />
                    <span className="min-w-0 truncate font-medium">
                        {status}
                    </span>
                    {plaud.email ? (
                        <span className="ml-auto min-w-0 truncate text-muted-foreground">
                            <span className="sr-only">{" · "}</span>
                            {plaud.email}
                        </span>
                    ) : null}
                </p>

                <dl className="divide-y divide-border">
                    <div className="flex items-center justify-between gap-3 px-4 py-3">
                        <dt className="text-sm text-muted-foreground">
                            Last sync
                        </dt>
                        <dd className="text-right text-sm tabular-nums">
                            {relative(lastSyncTime)}
                        </dd>
                    </div>
                    <div className="flex items-center justify-between gap-3 px-4 py-3">
                        <dt className="text-sm text-muted-foreground">
                            Next sync
                        </dt>
                        <dd className="text-right text-sm tabular-nums">
                            {plaud.connected && nextSyncTime
                                ? relative(nextSyncTime)
                                : "Not scheduled"}
                        </dd>
                    </div>
                </dl>

                {plaud.connected ? (
                    <Button
                        data-testid="overview-sync-now"
                        variant="ghost"
                        className="h-11 w-full justify-start rounded-none bg-transparent px-4 hover:bg-accent"
                        disabled={isAutoSyncing}
                        onClick={() => {
                            void manualSync();
                        }}
                    >
                        {isAutoSyncing ? "Syncing…" : "Sync now"}
                    </Button>
                ) : (
                    <Button
                        asChild
                        variant="ghost"
                        className="h-11 w-full justify-start rounded-none bg-transparent px-4 hover:bg-accent"
                    >
                        <Link href="/settings/plaud-account">
                            Connect Plaud
                        </Link>
                    </Button>
                )}
            </div>
        </section>
    );
}
