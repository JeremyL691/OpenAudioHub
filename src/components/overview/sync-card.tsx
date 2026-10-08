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
        <section
            aria-labelledby="sync-card-heading"
            className="space-y-4 rounded-xl border bg-card p-5"
        >
            <div className="space-y-1">
                <h2 id="sync-card-heading" className="text-sm font-semibold">
                    Plaud sync
                </h2>
                <p className="text-sm">
                    {status}
                    {plaud.email ? (
                        <span className="text-muted-foreground">
                            {" · "}
                            {plaud.email}
                        </span>
                    ) : null}
                </p>
            </div>

            <dl className="grid grid-cols-2 gap-3 text-xs text-muted-foreground">
                <div className="space-y-0.5">
                    <dt>Last sync</dt>
                    <dd className="text-sm text-foreground">
                        {relative(lastSyncTime)}
                    </dd>
                </div>
                <div className="space-y-0.5">
                    <dt>Next sync</dt>
                    <dd className="text-sm text-foreground">
                        {plaud.connected && nextSyncTime
                            ? relative(nextSyncTime)
                            : "Not scheduled"}
                    </dd>
                </div>
            </dl>

            {plaud.connected ? (
                <Button
                    data-testid="overview-sync-now"
                    variant="outline"
                    className="w-full"
                    disabled={isAutoSyncing}
                    onClick={() => {
                        void manualSync();
                    }}
                >
                    {isAutoSyncing ? "Syncing…" : "Sync now"}
                </Button>
            ) : (
                <Button asChild variant="outline" className="w-full">
                    <Link href="/settings/plaud-account">Connect Plaud</Link>
                </Button>
            )}
        </section>
    );
}
