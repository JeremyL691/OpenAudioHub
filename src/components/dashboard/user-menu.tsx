"use client";

import {
    Keyboard,
    LogOut,
    Monitor,
    Moon,
    RefreshCw,
    Settings,
    Sun,
    Unplug,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useSyncStatus } from "@/components/app-shell/providers";
import {
    SyncRing,
    type SyncRingState,
    syncRingLabel,
    syncRingState,
} from "@/components/app-shell/sync-ring";
import { useDesktopMode } from "@/components/desktop-mode-provider";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import { type Theme, useTheme } from "@/hooks/use-theme";
import { signOut } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

interface UserMenuProps {
    initialTheme: "light" | "dark" | "system";
    userEmail: string | null;
    onOpenSettings: () => void;
    onOpenShortcuts: () => void;
}

function Kbd({ children }: { children: React.ReactNode }) {
    return (
        <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-muted px-1 font-mono text-[10px] text-muted-foreground">
            {children}
        </kbd>
    );
}

const SYNC_ARIA_SUFFIX: Record<SyncRingState, string> = {
    ok: ", synced",
    failed: ", sync failed",
    syncing: ", syncing",
    idle: ", not synced yet",
};

function emailInitial(email: string | null): string {
    if (!email) return "?";
    const trimmed = email.trim();
    if (!trimmed) return "?";
    return trimmed[0].toUpperCase();
}

export function UserMenu({
    initialTheme,
    userEmail,
    onOpenSettings,
    onOpenShortcuts,
}: UserMenuProps) {
    const { push, refresh } = useRouter();
    const { theme, setTheme } = useTheme(initialTheme);
    const isDesktop = useDesktopMode();
    const {
        isAutoSyncing,
        lastSyncTime,
        nextSyncTime,
        lastSyncResult,
        manualSync,
    } = useSyncStatus();
    const syncInput = {
        isAutoSyncing,
        lastSyncTime,
        nextSyncTime,
        lastSyncResult,
    };
    const syncState = syncRingState(syncInput);

    const themeOptions = [
        { value: "light" as const, label: "Light", icon: Sun },
        { value: "dark" as const, label: "Dark", icon: Moon },
        { value: "system" as const, label: "Auto", icon: Monitor },
    ];

    return (
        <DropdownMenu>
            <Tooltip>
                <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                        <Button
                            variant="outline"
                            size="icon"
                            aria-label={`Account menu${SYNC_ARIA_SUFFIX[syncState]}`}
                            data-testid="user-menu"
                            data-sync-state={syncState}
                            className="relative size-10 rounded-full bg-muted font-semibold text-foreground hover:bg-accent sm:size-8"
                        >
                            {emailInitial(userEmail)}
                            <SyncRing state={syncState} />
                        </Button>
                    </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                    {syncRingLabel(syncInput)}
                </TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className="w-72 p-0">
                <div className="flex items-center gap-3 border-b p-3">
                    <div
                        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary"
                        aria-hidden="true"
                    >
                        {emailInitial(userEmail)}
                    </div>
                    <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                            {isDesktop
                                ? "OpenAudioHub"
                                : userEmail || "Signed in"}
                        </p>
                        <p className="text-xs text-muted-foreground">
                            {isDesktop ? "Local account" : "Signed in"}
                        </p>
                    </div>
                </div>

                <div className="p-1">
                    <DropdownMenuItem
                        disabled={isAutoSyncing}
                        onSelect={() => {
                            void manualSync();
                        }}
                    >
                        <RefreshCw
                            className={cn(
                                isAutoSyncing && "motion-safe:animate-spin",
                            )}
                        />
                        <span className="flex-1">Sync now</span>
                    </DropdownMenuItem>
                    {lastSyncResult?.needsReconnect === true && (
                        <DropdownMenuItem
                            onSelect={() => push("/settings/plaud-account")}
                        >
                            <Unplug />
                            <span className="flex-1">Reconnect Plaud</span>
                        </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onSelect={onOpenSettings}>
                        <Settings />
                        <span className="flex-1">Settings</span>
                        <Kbd>,</Kbd>
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={onOpenShortcuts}>
                        <Keyboard />
                        <span className="flex-1">Keyboard shortcuts</span>
                        <Kbd>?</Kbd>
                    </DropdownMenuItem>
                </div>

                <DropdownMenuLabel className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Theme
                </DropdownMenuLabel>
                {/* Radix radio items, so the menu owns only items and groups.
                    Picking a theme keeps the menu open, as the old segmented
                    control did. */}
                <DropdownMenuRadioGroup
                    value={theme}
                    onValueChange={(value) => setTheme(value as Theme)}
                >
                    {themeOptions.map((opt) => (
                        <DropdownMenuRadioItem
                            key={opt.value}
                            value={opt.value}
                            onSelect={(event) => event.preventDefault()}
                        >
                            <opt.icon className="size-3.5" aria-hidden="true" />
                            {opt.label}
                        </DropdownMenuRadioItem>
                    ))}
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator className="my-0" />

                {/* Sign out. The desktop app signs itself in, so there is nothing to sign out of. */}
                {!isDesktop && (
                    <div className="p-1">
                        <DropdownMenuItem
                            variant="destructive"
                            onSelect={async () => {
                                await signOut();
                                push("/");
                                refresh();
                            }}
                        >
                            <LogOut />
                            Log out
                        </DropdownMenuItem>
                    </div>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
