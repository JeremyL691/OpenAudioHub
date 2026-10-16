"use client";

import { formatDistanceToNow } from "date-fns";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useSyncStatus } from "@/components/app-shell/providers";
import { Button } from "@/components/ui/button";
import type { PlaudStatus } from "@/db/queries/overview";

function syncText(plaud: PlaudStatus, lastSyncTime: Date | null): string {
    if (!plaud.connected) return "Plaud not connected";
    if (plaud.needsReconnect) return "Plaud sign-in expired";
    if (!lastSyncTime) return "Not synced yet";
    return `Last synced ${formatDistanceToNow(lastSyncTime, { addSuffix: true })}`;
}

/** Title, today's date, the Plaud sync state with Sync now, and a reconnect prompt when needed. */
export function OverviewHeader({ plaud }: { plaud: PlaudStatus }) {
    const { isAutoSyncing, lastSyncTime, manualSync } = useSyncStatus();
    const [today, setToday] = useState("");

    useEffect(() => {
        setToday(
            new Date().toLocaleDateString(undefined, {
                weekday: "long",
                month: "long",
                day: "numeric",
            }),
        );
    }, []);

    return (
        <div className="space-y-3">
            <header className="space-y-1">
                <h1 className="text-[28px] font-bold tracking-tight">
                    Dashboard
                </h1>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                    <span>{today}</span>
                    <span aria-hidden="true">·</span>
                    <section
                        aria-label="Plaud sync"
                        className="flex flex-wrap items-center gap-x-2 gap-y-1"
                    >
                        <span>{syncText(plaud, lastSyncTime)}</span>
                        {plaud.connected && !plaud.needsReconnect ? (
                            <Button
                                data-testid="overview-sync-now"
                                variant="secondary"
                                size="sm"
                                disabled={isAutoSyncing}
                                onClick={() => {
                                    void manualSync();
                                }}
                            >
                                {isAutoSyncing ? "Syncing…" : "Sync now"}
                            </Button>
                        ) : null}
                    </section>
                </div>
            </header>
            {plaud.needsReconnect ? (
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-xl bg-muted px-4 py-2.5 text-sm">
                    <span className="flex items-center gap-2">
                        <span
                            aria-hidden="true"
                            className="size-2 shrink-0 rounded-full bg-warning"
                        />
                        Reconnect Plaud to keep recordings syncing.
                    </span>
                    <Link
                        href="/settings/plaud-account"
                        className="font-medium text-link"
                    >
                        Reconnect
                    </Link>
                </div>
            ) : null}
        </div>
    );
}
