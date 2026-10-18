import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { usePlayer } from "./player-context";

/** Window event the shortcut Ctrl/Cmd+K fires. The command palette listens for it. */
export const OPEN_COMMAND_PALETTE_EVENT = "oah:open-command-palette";
/** Window event that opens the shortcuts dialog (the account menu fires it). */
export const OPEN_SHORTCUTS_EVENT = "oah:open-shortcuts";

const SHORTCUT_GROUPS = [
    {
        title: "Global",
        rows: [
            { label: "Command palette", keys: ["⌘", "K"] },
            { label: "Show this cheatsheet", keys: ["?"] },
            { label: "Open settings", keys: [","] },
            { label: "Focus search", keys: ["/"] },
        ],
    },
    {
        title: "Recording list",
        rows: [
            { label: "Next recording", keys: ["j"] },
            { label: "Previous recording", keys: ["k"] },
        ],
    },
    {
        title: "Player",
        rows: [
            { label: "Play / pause", keys: ["Space"] },
            { label: "Seek back 5s", keys: ["←"] },
            { label: "Seek forward 5s", keys: ["→"] },
            { label: "Volume up", keys: ["↑"] },
            { label: "Volume down", keys: ["↓"] },
        ],
    },
] as const;

const DETAIL_PATH = /^\/recordings\/[^/]+$/;
const NON_SHORTCUT_CONTROLS = '[role="slider"],[role="menu"],[role="menuitem"],[role="listbox"],[role="option"],[role="tablist"],[role="radiogroup"]';

function isTextEntry(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el || !el.tagName) return false;
    if (el.isContentEditable) return true;
    return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
}

function within(target: EventTarget | null, selector: string): boolean {
    const el = target as Element | null;
    return Boolean(el && typeof el.closest === "function" && el.closest(selector));
}

/** True while a dialog (the palette, this sheet, an onboarding dialog) is open. It owns the keys then. */
function modalOpen(): boolean {
    return document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]') !== null;
}

/**
 * Global keyboard shortcuts and the shortcuts dialog (spec/ui-library.md section 5). The shell mounts it once.
 * Player keys act only on the detail page, and j and k only on the library.
 */
export function KeyboardShortcuts() {
    const [open, setOpen] = useState(false);
    const player = usePlayer();
    const navigate = useNavigate();
    const { pathname, search } = useLocation();
    const latest = useRef({ player, navigate, pathname, search });

    useEffect(() => {
        latest.current = { player, navigate, pathname, search };
    });

    useEffect(() => {
        const openSheet = () => setOpen(true);
        window.addEventListener(OPEN_SHORTCUTS_EVENT, openSheet);
        // The library may select a row without putting it in the address, so the last clicked row is remembered too.
        let lastClickedRow: string | null = null;
        const onClick = (e: MouseEvent) => {
            const row = (e.target as Element | null)?.closest?.('[data-testid="recording-row"]');
            if (row) lastClickedRow = row.getAttribute("data-id");
        };
        document.addEventListener("click", onClick, true);

        const onKey = (e: KeyboardEvent) => {
            const { player: p, navigate: go, pathname: path, search: query } = latest.current;

            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
                e.preventDefault();
                window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE_EVENT));
                return;
            }
            if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
            if (isTextEntry(e.target) || within(e.target, NON_SHORTCUT_CONTROLS)) return;
            const modal = modalOpen();

            switch (e.key) {
                case "?":
                    if (modal) return;
                    setOpen(true);
                    return;
                case ",":
                    if (modal) return;
                    if (!path.startsWith("/settings")) go("/settings");
                    return;
                case "/": {
                    if (modal) return;
                    const field = document.querySelector<HTMLInputElement>('[data-testid="recording-search"]');
                    if (field) {
                        e.preventDefault();
                        field.focus();
                    }
                    return;
                }
                case "j":
                case "k":
                    if (modal || path !== "/recordings") return;
                    moveSelection(e.key === "j" ? 1 : -1, query, lastClickedRow);
                    return;
                case " ":
                    // A focused button keeps its own Space activation.
                    if (!p || modal || !DETAIL_PATH.test(path) || within(e.target, "button,a,[role=button]")) return;
                    e.preventDefault();
                    p.toggle();
                    return;
                case "ArrowLeft":
                case "ArrowRight":
                    if (!p || modal || !DETAIL_PATH.test(path)) return;
                    e.preventDefault();
                    p.skip(e.key === "ArrowLeft" ? -5 : 5);
                    return;
                case "ArrowUp":
                case "ArrowDown":
                    if (!p || modal || !DETAIL_PATH.test(path)) return;
                    e.preventDefault();
                    p.setVolume(p.volume + (e.key === "ArrowUp" ? 5 : -5));
                    return;
                default:
                    return;
            }
        };
        window.addEventListener("keydown", onKey);
        return () => {
            window.removeEventListener("keydown", onKey);
            document.removeEventListener("click", onClick, true);
            window.removeEventListener(OPEN_SHORTCUTS_EVENT, openSheet);
        };
    }, []);

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent>
                <div className="flex flex-col gap-2 text-center sm:text-left">
                    <DialogTitle>Keyboard shortcuts</DialogTitle>
                    <DialogDescription>Power-user shortcuts available across the dashboard.</DialogDescription>
                </div>
                <div className="grid gap-5 sm:grid-cols-2">
                    {SHORTCUT_GROUPS.map((group) => (
                        <section key={group.title}>
                            <h3 className="mb-1.5 text-[13px] font-semibold text-foreground">{group.title}</h3>
                            <ul className="divide-y divide-border rounded-xl bg-muted">
                                {group.rows.map((row) => (
                                    <li key={row.label} className="flex items-center justify-between gap-4 px-3 py-1.5 text-[13px]">
                                        <span className="text-foreground">{row.label}</span>
                                        <span className="flex shrink-0 items-center gap-1">
                                            {row.keys.map((key) => (
                                                <Kbd key={key}>{key}</Kbd>
                                            ))}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </section>
                    ))}
                </div>
            </DialogContent>
        </Dialog>
    );
}

/** Moves the library selection to the next or previous row by clicking that row's main button. */
function moveSelection(direction: 1 | -1, search: string, lastClickedRow: string | null) {
    const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="recording-row"]'));
    if (rows.length === 0) return;
    const fromUrl = new URLSearchParams(search).get("id");
    const selected = rows.some((row) => row.dataset.id === fromUrl) ? fromUrl : lastClickedRow;
    const index = rows.findIndex((row) => row.dataset.id === selected);
    const next = index === -1 ? 0 : Math.min(rows.length - 1, Math.max(0, index + direction));
    rows[next].querySelector<HTMLElement>("button")?.click();
}
