"use client";

import { Command, Upload } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import {
    useDialogs,
    useSyncStatus,
    useTranscribeStatus,
    useUploadStatus,
} from "@/components/app-shell/providers";
import { UserMenu } from "@/components/dashboard/user-menu";
import { SyncButton } from "@/components/sync-button";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";

const TITLES: [prefix: string, title: string][] = [
    ["/recordings", "Recordings"],
    ["/dashboard", "Recordings"],
    ["/dev/demo-dashboard", "Recordings"],
    ["/settings", "Settings"],
];

function titleFor(pathname: string): string {
    const match = TITLES.find(
        ([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    );
    return match?.[1] ?? "";
}

interface TopBarProps {
    userEmail: string | null;
    initialTheme: "light" | "dark" | "system";
}

/**
 * Global actions for the signed-in app: sidebar toggle, page title, search,
 * sync, upload, and the account menu. Touch targets are 40px below `sm`.
 */
export function TopBar({ userEmail, initialTheme }: TopBarProps) {
    const pathname = usePathname();
    const { push } = useRouter();
    const { paletteAvailable, setPaletteOpen, setShortcutsOpen } = useDialogs();
    const {
        isAutoSyncing,
        lastSyncTime,
        nextSyncTime,
        lastSyncResult,
        manualSync,
    } = useSyncStatus();
    const { isUploading, uploadInputRef, handleUpload, triggerUpload } =
        useUploadStatus();
    const { inFlightActions } = useTranscribeStatus();

    // Any transcribe in flight (across all recordings) blocks new uploads.
    const anyTranscribing = Array.from(inFlightActions.values()).some(
        (kind) => kind === "transcribing",
    );
    const isProcessing = anyTranscribing || isUploading;

    return (
        <header
            data-testid="topbar"
            className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b bg-background/95 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/70 sm:px-4"
        >
            <SidebarTrigger className="size-10 md:size-7" />
            <p className="min-w-0 truncate text-sm font-semibold sm:text-base">
                {titleFor(pathname)}
            </p>
            <div className="ml-auto flex shrink-0 items-center gap-2">
                {paletteAvailable && (
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                onClick={() => setPaletteOpen(true)}
                                variant="outline"
                                size="sm"
                                className="hidden h-9 md:inline-flex"
                                aria-label="Open command palette"
                                data-testid="command-trigger"
                            >
                                <Command className="mr-2 size-4" />
                                <span>Search</span>
                                <kbd className="ml-2 hidden rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground lg:inline">
                                    ⌘K
                                </kbd>
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom">
                            Search recordings, transcripts, and actions
                        </TooltipContent>
                    </Tooltip>
                )}
                <SyncButton
                    lastSyncTime={lastSyncTime}
                    nextSyncTime={nextSyncTime}
                    isAutoSyncing={isAutoSyncing}
                    lastSyncResult={lastSyncResult}
                    onSync={() => {
                        void manualSync();
                    }}
                    className="h-10 sm:h-9"
                />
                <input
                    ref={uploadInputRef}
                    type="file"
                    accept="audio/*"
                    className="hidden"
                    onChange={handleUpload}
                />
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            onClick={triggerUpload}
                            data-testid="upload-button"
                            disabled={isProcessing}
                            variant="outline"
                            size="sm"
                            className="h-10 sm:h-9"
                            aria-label={
                                isUploading ? "Uploading audio" : "Upload audio"
                            }
                        >
                            <Upload className="size-4 sm:mr-2" />
                            <span className="hidden sm:inline">
                                {isUploading ? "Uploading…" : "Upload Audio"}
                            </span>
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                        Upload an audio file from your computer
                    </TooltipContent>
                </Tooltip>
                <UserMenu
                    initialTheme={initialTheme}
                    userEmail={userEmail}
                    onOpenSettings={() => push("/settings")}
                    onOpenShortcuts={() => setShortcutsOpen(true)}
                />
            </div>
        </header>
    );
}
