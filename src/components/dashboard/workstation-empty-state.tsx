"use client";

import { Mic, RefreshCw, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
    isSyncing: boolean;
    onSync: () => void;
    onUpload: () => void;
}

/**
 * Shown when the user has no recordings yet (and no in-flight upload).
 * Offers the two paths into having content: sync from a Plaud device
 * (the common case) or upload an audio file from disk.
 */
export function WorkstationEmptyState({ isSyncing, onSync, onUpload }: Props) {
    return (
        <div
            data-testid="empty-state"
            className="flex flex-col items-center justify-center text-center"
        >
            <Mic className="mb-4 size-14 text-muted-foreground" />
            <h3 className="mb-1 text-[15px] font-semibold">
                No recordings yet
            </h3>
            <p className="mb-6 max-w-md text-[13px] text-muted-foreground">
                Sync your Plaud device to import your recordings and start
                transcribing them.
            </p>
            <div className="flex gap-2">
                <Button
                    onClick={onSync}
                    disabled={isSyncing}
                    className="h-10 sm:h-8"
                >
                    {isSyncing ? (
                        <>
                            <RefreshCw className="mr-2 size-4 animate-spin" />
                            Syncing…
                        </>
                    ) : (
                        <>
                            <RefreshCw className="mr-2 size-4" />
                            Sync Device
                        </>
                    )}
                </Button>
                <Button
                    variant="outline"
                    onClick={onUpload}
                    className="h-10 sm:h-8"
                >
                    <Upload className="mr-2 size-4" />
                    Upload Audio
                </Button>
            </div>
        </div>
    );
}
