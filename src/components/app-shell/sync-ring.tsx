"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type SyncRingState = "ok" | "failed" | "syncing" | "idle";

export interface SyncRingInput {
    isAutoSyncing: boolean;
    lastSyncTime: Date | null;
    nextSyncTime: Date | null;
    lastSyncResult: {
        success: boolean;
        error?: string;
        needsReconnect?: boolean;
    } | null;
}

/** Maps the auto-sync state onto the avatar ring. A sync in flight wins over the last result. */
export function syncRingState({
    isAutoSyncing,
    lastSyncResult,
}: SyncRingInput): SyncRingState {
    if (isAutoSyncing) return "syncing";
    if (!lastSyncResult) return "idle";
    if (!lastSyncResult.success || lastSyncResult.needsReconnect === true) {
        return "failed";
    }
    return "ok";
}

/**
 * Compact relative-time string for the tooltip: "just now" / "2m ago" /
 * "3h ago" / "5d ago". date-fns defaults ("about 1 hour") read too long here.
 */
function compactAgo(from: Date): string {
    // Guard against `new Date(invalid)`: NaN would render "NaN m ago".
    const ts = from.getTime();
    if (!Number.isFinite(ts)) return "";
    const diffMs = Date.now() - ts;
    if (diffMs < 0) return "just now";
    const sec = Math.floor(diffMs / 1000);
    // Under a minute reads as "just now"; "0m ago" would look wrong.
    if (sec < 60) return "just now";
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    if (day < 7) return `${day}d ago`;
    const wk = Math.floor(day / 7);
    return `${wk}w ago`;
}

/** "Next sync in 3m" / "Next sync in 2h" / "Next sync soon". */
function nextSyncPhrase(to: Date): string {
    const ts = to.getTime();
    if (!Number.isFinite(ts)) return "";
    const min = Math.ceil((ts - Date.now()) / 60_000);
    if (min <= 0) return "Next sync soon";
    if (min < 60) return `Next sync in ${min}m`;
    return `Next sync in ${Math.round(min / 60)}h`;
}

/** Tooltip text for the avatar: sync time and status. */
export function syncRingLabel(input: SyncRingInput): string {
    const state = syncRingState(input);
    if (state === "syncing") return "Syncing…";
    if (state === "failed") {
        if (input.lastSyncResult?.needsReconnect === true) {
            return "Plaud needs reconnecting";
        }
        const error = input.lastSyncResult?.error;
        return error ? `Sync failed: ${error}` : "Sync failed";
    }
    if (state === "ok") {
        const ago = input.lastSyncTime
            ? `Synced ${compactAgo(input.lastSyncTime)}`
            : "Synced";
        return input.nextSyncTime
            ? `${ago} · ${nextSyncPhrase(input.nextSyncTime)}`
            : ago;
    }
    return input.lastSyncTime
        ? `Last synced ${compactAgo(input.lastSyncTime)}`
        : "Not synced yet";
}

const RING_CLASS: Record<SyncRingState, string> = {
    ok: "border-success",
    failed: "border-destructive",
    // Arc on a faint track; the spin is dropped when reduced motion is requested.
    syncing: "border-primary/25 border-t-primary motion-safe:animate-spin",
    idle: "border-muted-foreground/40",
};

/** Solid ring drawn just outside the avatar; the children are the avatar trigger. */
export function SyncRing({
    state,
    children,
}: {
    state: SyncRingState;
    children: ReactNode;
}) {
    return (
        <span className="relative inline-flex rounded-full">
            {children}
            <span
                aria-hidden="true"
                className={cn(
                    "pointer-events-none absolute -inset-[3px] rounded-full border-2",
                    RING_CLASS[state],
                )}
            />
        </span>
    );
}
