"use client";

import { ChevronDown, ChevronUp } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getApiErrorMessage } from "@/lib/api-errors";
import { formatDurationMs } from "@/lib/format-duration";
import {
    MAX_RECORDING_TITLE_LENGTH,
    normalizeRecordingTitle,
} from "@/lib/recordings/filename";
import type { Recording } from "@/types/recording";

export type MergeOrderMode = "time" | "import";

/** Sort ascending by recording time or by import time. Returns a new array. */
export function orderRecordings(
    recordings: Recording[],
    mode: MergeOrderMode,
): Recording[] {
    const field = mode === "time" ? "startTime" : "createdAt";
    return [...recordings].sort(
        (a, b) => Date.parse(a[field]) - Date.parse(b[field]),
    );
}

/** Swap the item at `index` with its neighbour in direction `delta`. */
export function moveItem<T>(list: T[], index: number, delta: -1 | 1): T[] {
    const target = index + delta;
    if (target < 0 || target >= list.length) return list;
    const next = [...list];
    [next[index], next[target]] = [next[target], next[index]];
    return next;
}

interface MergeRecordingsDialogProps {
    /** The selected recordings, in any order. */
    recordings: Recording[];
    open: boolean;
    onClose: () => void;
    onMerged: () => void;
}

export function MergeRecordingsDialog({
    recordings,
    open,
    onClose,
    onMerged,
}: MergeRecordingsDialogProps) {
    const router = useRouter();
    const [items, setItems] = useState<Recording[]>([]);
    const [orderMode, setOrderMode] = useState<MergeOrderMode | null>("time");
    // null means "follow the first item"; a string means the user edited it.
    const [titleDraft, setTitleDraft] = useState<string | null>(null);
    const [deleteOriginals, setDeleteOriginals] = useState(false);
    const [saving, setSaving] = useState(false);
    const [prevOpen, setPrevOpen] = useState(open);

    // Reset whenever the dialog opens (state is adjusted during render).
    if (open !== prevOpen) {
        setPrevOpen(open);
        if (open) {
            setItems(orderRecordings(recordings, "time"));
            setOrderMode("time");
            setTitleDraft(null);
            setDeleteOriginals(false);
        }
    }

    const defaultTitle = items[0] ? `${items[0].filename} (merged)` : "";
    const title = titleDraft ?? defaultTitle;
    const totalMs = items.reduce((sum, r) => sum + r.duration, 0);

    const applyOrder = (mode: MergeOrderMode) => {
        setItems(orderRecordings(recordings, mode));
        setOrderMode(mode);
    };

    const move = (index: number, delta: -1 | 1) => {
        setItems((prev) => moveItem(prev, index, delta));
        setOrderMode(null);
    };

    const save = async () => {
        const next = normalizeRecordingTitle(title);
        if (!next) {
            toast.error("Title cannot be empty");
            return;
        }
        if (next.length > MAX_RECORDING_TITLE_LENGTH) {
            toast.error(
                `Title must be ${MAX_RECORDING_TITLE_LENGTH} characters or fewer`,
            );
            return;
        }

        setSaving(true);
        try {
            const response = await fetch("/api/recordings/merge", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    ids: items.map((r) => r.id),
                    title: next,
                }),
            });
            if (!response.ok) {
                toast.error(
                    await getApiErrorMessage(response, "Failed to merge"),
                );
                return;
            }
            const { id } = (await response.json()) as { id: string };

            if (deleteOriginals) {
                let failed = 0;
                for (const r of items) {
                    try {
                        const del = await fetch(`/api/recordings/${r.id}`, {
                            method: "DELETE",
                        });
                        if (!del.ok) failed++;
                    } catch {
                        failed++;
                    }
                }
                if (failed > 0) {
                    toast.error(
                        `Merged, but ${failed} original recording${failed === 1 ? "" : "s"} could not be deleted`,
                    );
                }
            }

            toast.success("Recordings merged", {
                action: {
                    label: "Open",
                    onClick: () => router.push(`/recordings/${id}`),
                },
            });
            router.refresh();
            onMerged();
            onClose();
        } catch {
            toast.error("Failed to merge");
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog
            open={open}
            onOpenChange={(nextOpen) => {
                if (!nextOpen && !saving) onClose();
            }}
        >
            <DialogContent className="gap-4 sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>Merge recordings</DialogTitle>
                    <DialogDescription>
                        Combine the selected recordings into one new recording.
                    </DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-3">
                    <div className="flex items-center justify-between gap-2">
                        <div className="flex gap-1.5">
                            <Button
                                type="button"
                                size="sm"
                                variant={
                                    orderMode === "time" ? "default" : "outline"
                                }
                                aria-pressed={orderMode === "time"}
                                disabled={saving}
                                onClick={() => applyOrder("time")}
                                data-testid="merge-order-time"
                                className="h-8 px-2.5 text-xs"
                            >
                                Recording time
                            </Button>
                            <Button
                                type="button"
                                size="sm"
                                variant={
                                    orderMode === "import"
                                        ? "default"
                                        : "outline"
                                }
                                aria-pressed={orderMode === "import"}
                                disabled={saving}
                                onClick={() => applyOrder("import")}
                                data-testid="merge-order-import"
                                className="h-8 px-2.5 text-xs"
                            >
                                Import order
                            </Button>
                        </div>
                        {orderMode === null && (
                            <span className="text-xs text-muted-foreground">
                                Custom order
                            </span>
                        )}
                    </div>

                    <ol
                        data-testid="merge-list"
                        className="flex max-h-64 flex-col gap-1 overflow-y-auto"
                    >
                        {items.map((recording, index) => (
                            <li
                                key={recording.id}
                                data-testid="merge-item"
                                data-id={recording.id}
                                className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5"
                            >
                                <span className="w-5 shrink-0 text-center text-xs tabular-nums text-muted-foreground">
                                    {index + 1}
                                </span>
                                <div className="min-w-0 flex-1">
                                    <div className="truncate text-[13px] font-medium">
                                        {recording.filename}
                                    </div>
                                    <div className="text-xs tabular-nums text-muted-foreground">
                                        {formatDurationMs(recording.duration)}
                                        {" · "}
                                        {new Date(
                                            recording.startTime,
                                        ).toLocaleString()}
                                    </div>
                                </div>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="size-8"
                                    aria-label={`Move ${recording.filename} up`}
                                    data-testid="merge-move-up"
                                    disabled={saving || index === 0}
                                    onClick={() => move(index, -1)}
                                >
                                    <ChevronUp className="size-4" />
                                </Button>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="size-8"
                                    aria-label={`Move ${recording.filename} down`}
                                    data-testid="merge-move-down"
                                    disabled={
                                        saving || index === items.length - 1
                                    }
                                    onClick={() => move(index, 1)}
                                >
                                    <ChevronDown className="size-4" />
                                </Button>
                            </li>
                        ))}
                    </ol>

                    <div className="text-xs tabular-nums text-muted-foreground">
                        Total: {formatDurationMs(totalMs)}
                    </div>

                    <div className="flex flex-col gap-1.5">
                        <Label htmlFor="merge-title-input">Title</Label>
                        <Input
                            id="merge-title-input"
                            data-testid="merge-title"
                            className="h-10 text-[13px] sm:h-8"
                            value={title}
                            maxLength={MAX_RECORDING_TITLE_LENGTH}
                            disabled={saving}
                            onChange={(event) =>
                                setTitleDraft(event.target.value)
                            }
                        />
                    </div>

                    <div className="flex items-center gap-2">
                        <input
                            id="merge-delete-originals-input"
                            type="checkbox"
                            data-testid="merge-delete-originals"
                            className="size-4 accent-primary"
                            checked={deleteOriginals}
                            disabled={saving}
                            onChange={(event) =>
                                setDeleteOriginals(event.target.checked)
                            }
                        />
                        <Label htmlFor="merge-delete-originals-input">
                            Delete original recordings after merging
                        </Label>
                    </div>
                </div>

                <DialogFooter className="gap-2 sm:justify-end">
                    <Button
                        type="button"
                        variant="outline"
                        className="h-10 px-4 sm:h-8"
                        onClick={onClose}
                        disabled={saving}
                    >
                        Cancel
                    </Button>
                    <Button
                        type="button"
                        className="h-10 px-4 sm:h-8"
                        data-testid="merge-confirm"
                        disabled={saving || items.length < 2}
                        onClick={() => void save()}
                    >
                        {saving ? "Merging…" : "Merge"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
