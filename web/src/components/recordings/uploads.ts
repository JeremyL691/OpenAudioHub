import { useSyncExternalStore } from "react";
import { toast } from "sonner";
import { errorMessage } from "@/lib/api";
import { uploadRecordings } from "@/lib/recordings";
import { t } from "@/lib/i18n";

// Uploads run one after another. The library shows them as pending rows, and the
// top-bar upload button can use the same store: call startUploads with the picked
// files, and read useUploads().busy to disable the button and show "Uploading audio".

export interface PendingUpload {
    key: string;
    name: string;
}

interface UploadState {
    pending: PendingUpload[];
}

let state: UploadState = { pending: [] };
const listeners = new Set<() => void>();
let counter = 0;
let queue: Promise<void> = Promise.resolve();

function setState(next: UploadState): void {
    state = next;
    listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** Queues the files for upload. Each one gets a toast with its result. */
export function startUploads(files: File[]): void {
    for (const file of files) {
        const key = String(++counter);
        setState({ pending: [...state.pending, { key, name: file.name }] });
        queue = queue.then(async () => {
            try {
                await uploadRecordings([file]);
                toast.success(t("library.uploadedToast", { name: file.name }));
            } catch (err) {
                toast.error(errorMessage(err, t("library.uploadFailed")));
            } finally {
                setState({ pending: state.pending.filter((p) => p.key !== key) });
            }
        });
    }
}

export function useUploads(): { pending: PendingUpload[]; busy: boolean } {
    const snapshot = useSyncExternalStore(subscribe, () => state, () => state);
    return { pending: snapshot.pending, busy: snapshot.pending.length > 0 };
}
