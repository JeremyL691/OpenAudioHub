import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { ChevronDown, ChevronUp } from "lucide-react";
import { toast } from "sonner";
import { AlertDialogCancel, AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import { formatClock, formatDateTime } from "@/lib/format";
import { errorMessage } from "@/lib/api";
import { deleteRecording, mergeRecordings, renameRecording, type Recording } from "@/lib/recordings";

const NAME_LIMIT = 200;

// ---------------------------------------------------------------------------
// Rename
// ---------------------------------------------------------------------------

export interface RenameDialogProps {
    target: Recording | null;
    onClose(): void;
    onRenamed(id: string, filename: string): void;
}

export function RenameDialog({ target, onClose, onRenamed }: RenameDialogProps) {
    return (
        <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
            <DialogContent>
                <DialogTitle>Rename recording</DialogTitle>
                {target ? (
                    <RenameForm
                        key={target.id}
                        recording={target}
                        onCancel={onClose}
                        onSaved={(filename) => onRenamed(target.id, filename)}
                    />
                ) : null}
            </DialogContent>
        </Dialog>
    );
}

function RenameForm({ recording, onCancel, onSaved }: { recording: Recording; onCancel(): void; onSaved(filename: string): void }) {
    const [name, setName] = useState(recording.filename);
    const [saving, setSaving] = useState(false);

    async function save(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const next = name.trim();
        if (!next) {
            toast.error("Name cannot be empty");
            return;
        }
        if (next.length > NAME_LIMIT) {
            toast.error(`Name must be ${NAME_LIMIT} characters or fewer`);
            return;
        }
        if (next === recording.filename) {
            onCancel();
            return;
        }
        setSaving(true);
        try {
            const saved = await renameRecording(recording.id, next);
            onSaved(saved);
        } catch (err) {
            toast.error(errorMessage(err, "Could not rename recording"));
            setSaving(false);
        }
    }

    return (
        <form className="grid gap-4" onSubmit={save}>
            <Field label="Name">
                <Input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
            </Field>
            <DialogFooter>
                <Button variant="secondary" onClick={onCancel}>
                    Cancel
                </Button>
                <Button type="submit" variant="primary" disabled={saving}>
                    Save
                </Button>
            </DialogFooter>
        </form>
    );
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

export interface MergeDialogProps {
    /** The selected recordings at the moment the dialog opened, or null when closed. */
    sources: Recording[] | null;
    onClose(): void;
    onMerged(newId: string): void;
}

export function MergeDialog({ sources, onClose, onMerged }: MergeDialogProps) {
    return (
        <Dialog open={sources !== null} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
                <DialogTitle>Merge recordings</DialogTitle>
                <DialogDescription>Combine the selected recordings into one new recording.</DialogDescription>
                {sources ? <MergeForm sources={sources} onClose={onClose} onMerged={onMerged} /> : null}
            </DialogContent>
        </Dialog>
    );
}

type OrderMode = "time" | "import";

function byTime(list: Recording[]): Recording[] {
    return [...list].sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
}

function byImport(list: Recording[]): Recording[] {
    return [...list].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

function MergeForm({ sources, onClose, onMerged }: { sources: Recording[]; onClose(): void; onMerged(newId: string): void }) {
    const navigate = useNavigate();
    const [items, setItems] = useState<Recording[]>(() => byTime(sources));
    const [mode, setMode] = useState<OrderMode | null>("time");
    const [title, setTitle] = useState(() => `${byTime(sources)[0]?.filename ?? ""} (merged)`);
    const [deleteOriginals, setDeleteOriginals] = useState(false);
    const [busy, setBusy] = useState(false);

    function chooseOrder(next: OrderMode) {
        setMode(next);
        setItems(next === "time" ? byTime(items) : byImport(items));
    }

    function move(index: number, direction: -1 | 1) {
        const target = index + direction;
        if (target < 0 || target >= items.length) return;
        const next = [...items];
        [next[index], next[target]] = [next[target], next[index]];
        setItems(next);
        setMode(null);
    }

    async function merge() {
        setBusy(true);
        try {
            const newId = await mergeRecordings(
                items.map((r) => r.id),
                title.trim() || undefined,
            );
            let failed = 0;
            if (deleteOriginals) {
                for (const r of items) {
                    try {
                        await deleteRecording(r.id);
                    } catch {
                        failed += 1;
                    }
                }
            }
            toast.success("Recordings merged", {
                action: { label: "Open", onClick: () => navigate(`/recordings/${newId}`) },
            });
            if (failed > 0) {
                toast.error(`Merged, but ${failed} original recording(s) could not be deleted`);
            }
            onMerged(newId);
        } catch (err) {
            toast.error(errorMessage(err, "Could not merge recordings"));
            setBusy(false);
        }
    }

    const totalMs = items.reduce((total, r) => total + r.duration, 0);

    return (
        <div className="grid gap-4">
            <div className="flex items-center justify-between gap-2">
                <div className="flex gap-1.5">
                    <Button
                        variant={mode === "time" ? "primary" : "ghost"}
                        size="sm"
                        data-testid="merge-order-time"
                        aria-pressed={mode === "time"}
                        className={cn(mode !== "time" && "border border-border bg-background")}
                        onClick={() => chooseOrder("time")}
                    >
                        Recording time
                    </Button>
                    <Button
                        variant={mode === "import" ? "primary" : "ghost"}
                        size="sm"
                        data-testid="merge-order-import"
                        aria-pressed={mode === "import"}
                        className={cn(mode !== "import" && "border border-border bg-background")}
                        onClick={() => chooseOrder("import")}
                    >
                        Import order
                    </Button>
                </div>
            </div>

            <ol data-testid="merge-list" className="flex max-h-64 flex-col gap-1 overflow-y-auto">
                {items.map((r, index) => (
                    <li key={r.id} data-testid="merge-item" data-id={r.id} className="flex items-center gap-2 rounded-lg bg-muted px-2 py-1.5">
                        <span className="w-5 shrink-0 text-center text-xs tabular-nums text-muted-foreground">{index + 1}</span>
                        <div className="min-w-0 flex-1">
                            <div className="truncate text-[13px] font-medium text-foreground">{r.filename}</div>
                            <div className="text-xs tabular-nums text-muted-foreground">
                                {formatClock(r.duration / 1000)} · {formatDateTime(r.startTime)}
                            </div>
                        </div>
                        <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Move ${r.filename} up`}
                            data-testid="merge-move-up"
                            disabled={index === 0}
                            onClick={() => move(index, -1)}
                        >
                            <ChevronUp />
                        </Button>
                        <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Move ${r.filename} down`}
                            data-testid="merge-move-down"
                            disabled={index === items.length - 1}
                            onClick={() => move(index, 1)}
                        >
                            <ChevronDown />
                        </Button>
                    </li>
                ))}
            </ol>
            <div data-testid="merge-total" className="text-xs tabular-nums text-muted-foreground">
                Total: {formatClock(totalMs / 1000)}
            </div>

            <Field label="Title">
                <Input data-testid="merge-title" value={title} onChange={(event) => setTitle(event.target.value)} />
            </Field>

            <label className="flex items-center gap-2 text-[13px] font-medium text-foreground">
                <input
                    type="checkbox"
                    data-testid="merge-delete-originals"
                    checked={deleteOriginals}
                    onChange={(event) => setDeleteOriginals(event.target.checked)}
                    className="size-4 accent-primary"
                />
                Delete original recordings after merging
            </label>

            <DialogFooter>
                <Button variant="secondary" onClick={onClose}>
                    Cancel
                </Button>
                <Button variant="primary" data-testid="merge-confirm" disabled={items.length < 2 || busy} onClick={merge}>
                    Merge
                </Button>
            </DialogFooter>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Delete (from a row's menu)
// ---------------------------------------------------------------------------

export interface DeleteDialogProps {
    target: Recording | null;
    busy: boolean;
    onCancel(): void;
    onConfirm(): void;
}

export function DeleteDialog({ target, busy, onCancel, onConfirm }: DeleteDialogProps) {
    return (
        <AlertDialog open={target !== null} onOpenChange={(open) => !open && onCancel()}>
            <AlertDialogContent>
                <AlertDialogTitle>Delete this recording?</AlertDialogTitle>
                <AlertDialogDescription>
                    <span className="block font-medium text-foreground">{target?.filename}</span>
                    This removes the audio file along with any transcript or summary. If the file still lives on your Plaud device, a later sync
                    will pull it back down.
                </AlertDialogDescription>
                <AlertDialogFooter>
                    <AlertDialogCancel asChild>
                        <Button variant="secondary" disabled={busy}>
                            Cancel
                        </Button>
                    </AlertDialogCancel>
                    <Button variant="primary" disabled={busy} onClick={onConfirm}>
                        {busy ? "Deleting…" : "Delete"}
                    </Button>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
