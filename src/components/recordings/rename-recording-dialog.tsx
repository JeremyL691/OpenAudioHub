"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getApiErrorMessage } from "@/lib/api-errors";
import {
    MAX_RECORDING_TITLE_LENGTH,
    normalizeRecordingTitle,
} from "@/lib/recordings/filename";

interface RenameRecordingDialogProps {
    /** The recording being renamed. Null while the dialog is closed. */
    recording: { id: string; filename: string } | null;
    onClose: () => void;
    onRenamed: (recordingId: string, filename: string) => void;
}

/**
 * Rename one recording from the library. It uses the same PATCH call as the
 * title on the detail page, so both places enforce the same name rules.
 */
export function RenameRecordingDialog({
    recording,
    onClose,
    onRenamed,
}: RenameRecordingDialogProps) {
    const [draft, setDraft] = useState("");
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (recording) setDraft(recording.filename);
    }, [recording]);

    const save = async () => {
        if (!recording) return;
        const next = normalizeRecordingTitle(draft);
        if (!next) {
            toast.error("Name cannot be empty");
            return;
        }
        if (next.length > MAX_RECORDING_TITLE_LENGTH) {
            toast.error(
                `Name must be ${MAX_RECORDING_TITLE_LENGTH} characters or fewer`,
            );
            return;
        }
        if (next === recording.filename) {
            onClose();
            return;
        }

        setSaving(true);
        try {
            const response = await fetch(`/api/recordings/${recording.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ filename: next }),
            });
            if (!response.ok) {
                toast.error(
                    await getApiErrorMessage(response, "Failed to rename"),
                );
                return;
            }
            const body = (await response.json()) as { filename?: string };
            onRenamed(recording.id, body.filename ?? next);
            onClose();
        } catch {
            toast.error("Failed to rename");
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog
            open={recording !== null}
            onOpenChange={(open) => {
                if (!open && !saving) onClose();
            }}
        >
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Rename recording</DialogTitle>
                </DialogHeader>
                <form
                    className="space-y-2"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void save();
                    }}
                >
                    <Label htmlFor="rename-recording-input">Name</Label>
                    <Input
                        id="rename-recording-input"
                        value={draft}
                        maxLength={MAX_RECORDING_TITLE_LENGTH}
                        disabled={saving}
                        autoFocus
                        onChange={(event) => setDraft(event.target.value)}
                    />
                    <DialogFooter>
                        <Button
                            type="button"
                            variant="outline"
                            onClick={onClose}
                            disabled={saving}
                        >
                            Cancel
                        </Button>
                        <Button type="submit" disabled={saving}>
                            Save
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
