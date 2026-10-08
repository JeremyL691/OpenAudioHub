"use client";

import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";

interface ShortcutsDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

interface ShortcutRow {
    keys: string[];
    description: string;
}

const groups: { title: string; rows: ShortcutRow[] }[] = [
    {
        title: "Global",
        rows: [
            { keys: ["⌘", "K"], description: "Command palette" },
            { keys: ["?"], description: "Show this cheatsheet" },
            { keys: [","], description: "Open settings" },
            { keys: ["/"], description: "Focus search" },
        ],
    },
    {
        title: "Recording list",
        rows: [
            { keys: ["j"], description: "Next recording" },
            { keys: ["k"], description: "Previous recording" },
            // No `Enter → Focus player` row here: selecting a recording
            // via j/k already mounts the player; there's no separate
            // "focus the player" gesture and adding one would conflict
            // with the search box's Enter handler.
        ],
    },
    {
        title: "Player",
        rows: [
            { keys: ["Space"], description: "Play / pause" },
            { keys: ["←"], description: "Seek back 5s" },
            { keys: ["→"], description: "Seek forward 5s" },
            { keys: ["↑"], description: "Volume up" },
            { keys: ["↓"], description: "Volume down" },
        ],
    },
];

export function ShortcutsDialog({ open, onOpenChange }: ShortcutsDialogProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>Keyboard shortcuts</DialogTitle>
                    <DialogDescription>
                        Power-user shortcuts available across the dashboard.
                    </DialogDescription>
                </DialogHeader>
                <div className="space-y-5">
                    {groups.map((group) => (
                        <div key={group.title}>
                            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                                {group.title}
                            </h3>
                            <ul className="divide-y rounded-lg border">
                                {group.rows.map((row) => (
                                    <li
                                        key={row.description}
                                        className="flex items-center justify-between px-3 py-2.5 text-sm"
                                    >
                                        <span className="text-foreground">
                                            {row.description}
                                        </span>
                                        <span className="flex items-center gap-1">
                                            {row.keys.map((k) => (
                                                <Kbd key={k}>{k}</Kbd>
                                            ))}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    ))}
                </div>
            </DialogContent>
        </Dialog>
    );
}
