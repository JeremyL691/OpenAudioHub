"use client";

import Link from "next/link";
import {
    useSyncStatus,
    useUploadStatus,
} from "@/components/app-shell/providers";
import { Button } from "@/components/ui/button";

interface OverviewActionsProps {
    /** False when no transcription provider is configured yet. */
    hasProvider: boolean;
    /** The empty state also offers a sync, since there is nothing to show yet. */
    includeSync?: boolean;
}

/** Upload, optionally sync, and a hint toward the provider setup. */
export function OverviewActions({
    hasProvider,
    includeSync = false,
}: OverviewActionsProps) {
    const { isUploading, triggerUpload } = useUploadStatus();
    const { isAutoSyncing, manualSync } = useSyncStatus();

    return (
        <div className="flex flex-wrap items-center justify-center gap-2">
            <Button
                data-testid="overview-upload"
                variant="outline"
                disabled={isUploading}
                onClick={triggerUpload}
            >
                {isUploading ? "Uploading…" : "Upload audio"}
            </Button>
            {includeSync ? (
                <Button
                    data-testid="overview-sync"
                    variant="outline"
                    disabled={isAutoSyncing}
                    onClick={() => {
                        void manualSync();
                    }}
                >
                    {isAutoSyncing ? "Syncing…" : "Sync now"}
                </Button>
            ) : null}
            {hasProvider ? null : (
                <Button asChild variant="outline">
                    <Link href="/settings/providers">
                        Add a transcription provider
                    </Link>
                </Button>
            )}
        </div>
    );
}
