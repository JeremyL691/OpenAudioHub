import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { api, errorMessage } from "@/lib/api";
import { RECORDINGS_CHANGED } from "@/lib/recordings";
import { useI18n } from "@/lib/i18n";

/** Shown when the account has no recordings and no upload is running. */
export function LibraryEmpty({ onUpload }: { onUpload(): void }) {
    const { t } = useI18n();
    const [syncing, setSyncing] = useState(false);

    async function sync() {
        setSyncing(true);
        try {
            await api("/api/plaud/sync", { method: "POST", json: {} });
            window.dispatchEvent(new Event(RECORDINGS_CHANGED));
        } catch (err) {
            toast.error(errorMessage(err, t("library.syncFailed")));
        } finally {
            setSyncing(false);
        }
    }

    return (
        <div data-testid="empty-state" className="flex min-h-0 flex-1 items-center justify-center">
            <EmptyState
                headingLevel={2}
                title={t("library.noRecordingsYet")}
                description={t("library.emptyLibraryBody")}
                action={
                    <>
                        <Button variant="primary" disabled={syncing} onClick={sync}>
                            {syncing ? t("library.syncing") : t("library.syncDevice")}
                        </Button>
                        <Button variant="secondary" onClick={onUpload}>
                            {t("library.uploadAudioAction")}
                        </Button>
                    </>
                }
            />
        </div>
    );
}
