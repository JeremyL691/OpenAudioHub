import { useEffect, useState, type ReactNode } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { Command } from "cmdk";
import { Circle, FileText, Keyboard, Monitor, Moon, RefreshCw, Search, Settings, Sun, Upload, type LucideIcon } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { setTheme, useTheme, type ThemeChoice } from "@/lib/theme";
import { OPEN_SHORTCUTS_EVENT } from "./account-menu";
import { OPEN_COMMAND_PALETTE_EVENT } from "./top-bar";
import { useShellData } from "./shell-data";

const RECENT_LIMIT = 5;

/** The ⌘K palette on the library page (spec/ui-library.md 4). Opened by the top-bar trigger or the shortcut event. */
export function CommandPalette() {
    const { pathname } = useLocation();
    const [params] = useSearchParams();
    const navigate = useNavigate();
    const { recordings, syncNow, updateSettings, openUploadPicker } = useShellData();
    const selectedId = params.get("id");
    const [themeNow] = useTheme();
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const onLibrary = pathname === "/recordings";

    useEffect(() => {
        const onOpen = () => {
            if (window.location.pathname !== "/recordings") return;
            setQuery("");
            setOpen(true);
        };
        window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen);
        return () => window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen);
    }, []);

    useEffect(() => {
        if (!onLibrary) setOpen(false);
    }, [onLibrary]);

    const close = () => setOpen(false);
    const run = (action: () => void) => {
        close();
        action();
    };
    const recent = [...(recordings ?? [])]
        .sort((a, b) => Date.parse(b.startTime) - Date.parse(a.startTime))
        .slice(0, RECENT_LIMIT);

    const chooseTheme = (choice: ThemeChoice) => {
        setTheme(choice);
        updateSettings({ theme: choice }).catch(() => undefined);
    };

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent aria-describedby={undefined} hideClose className="top-[20%] translate-y-0 gap-0 overflow-hidden p-0">
                <DialogTitle className="sr-only">Command palette</DialogTitle>
                <DialogDescription className="sr-only">Search recordings or run an action.</DialogDescription>
                <Command label="Command palette" loop className="flex flex-col">
                    <div className="flex h-9 items-center gap-2 border-b border-border px-3">
                        <Search aria-hidden="true" className="size-4 shrink-0 opacity-50" />
                        <Command.Input
                            value={query}
                            onValueChange={setQuery}
                            placeholder="Search recordings, transcripts, or actions..."
                            className="flex w-full bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
                        />
                    </div>
                    <Command.List className="max-h-[60vh] overflow-y-auto p-2">
                        <Command.Empty className="px-3 py-6 text-center text-sm text-muted-foreground">No results.</Command.Empty>

                        <Command.Group heading="Recent" className={GROUP}>
                            {recent.map((r) => (
                                <PaletteItem
                                    key={r.id}
                                    icon={FileText}
                                    value={`recording ${r.filename} ${r.id}`}
                                    onSelect={() => run(() => navigate(`/recordings?id=${encodeURIComponent(r.id)}`))}
                                    trailing={
                                        r.id === selectedId ? (
                                            <span className="ml-auto flex shrink-0 items-center gap-1 text-[11px] text-primary">
                                                <Circle className="size-2 fill-current" aria-hidden="true" />
                                                Selected
                                            </span>
                                        ) : null
                                    }
                                >
                                    {r.filename}
                                </PaletteItem>
                            ))}
                        </Command.Group>

                        <Command.Group heading="Actions" className={GROUP}>
                            <PaletteItem icon={Upload} value="upload audio" onSelect={() => run(openUploadPicker)}>
                                Upload audio
                            </PaletteItem>
                            <PaletteItem icon={RefreshCw} value="sync device" onSelect={() => run(() => void syncNow())}>
                                Sync device
                            </PaletteItem>
                            <PaletteItem
                                icon={Settings}
                                value="open settings settings"
                                onSelect={() => run(() => navigate("/settings"))}
                                trailing={<Kbd className="ml-auto h-5 px-1 text-[10px]">,</Kbd>}
                            >
                                Open settings
                            </PaletteItem>
                            <PaletteItem
                                icon={Keyboard}
                                value="keyboard shortcuts"
                                onSelect={() => run(() => window.dispatchEvent(new Event(OPEN_SHORTCUTS_EVENT)))}
                                trailing={<Kbd className="ml-auto h-5 px-1 text-[10px]">?</Kbd>}
                            >
                                Keyboard shortcuts
                            </PaletteItem>
                        </Command.Group>

                        <Command.Group heading="Theme" className={GROUP}>
                            {THEME_CHOICES.map((item) => (
                                <PaletteItem
                                    key={item.value}
                                    icon={item.icon}
                                    value={item.value === "system" ? "theme auto system" : `theme ${item.value}`}
                                    onSelect={() => run(() => chooseTheme(item.value))}
                                    trailing={
                                        themeNow === item.value ? (
                                            <span className="ml-auto shrink-0 rounded-full border border-border px-2 py-px text-[11px] text-muted-foreground">Active</span>
                                        ) : null
                                    }
                                >
                                    {item.label}
                                </PaletteItem>
                            ))}
                        </Command.Group>
                    </Command.List>

                    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
                        <div className="flex flex-wrap items-center gap-3">
                            <span className="inline-flex items-center gap-1">
                                <Kbd>↑</Kbd>
                                <Kbd>↓</Kbd>
                                navigate
                            </span>
                            <span className="inline-flex items-center gap-1">
                                <Kbd>↵</Kbd>
                                select
                            </span>
                            <span className="inline-flex items-center gap-1">
                                <Kbd>esc</Kbd>
                                close
                            </span>
                        </div>
                        <span className="inline-flex items-center gap-1">
                            <Kbd>⌘K</Kbd>
                            toggle
                        </span>
                    </div>
                </Command>
            </DialogContent>
        </Dialog>
    );
}

const GROUP = "overflow-hidden p-1 text-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-muted-foreground";

const THEME_CHOICES: { value: ThemeChoice; label: string; icon: LucideIcon }[] = [
    { value: "light", label: "Light", icon: Sun },
    { value: "dark", label: "Dark", icon: Moon },
    { value: "system", label: "Auto", icon: Monitor },
];

function PaletteItem({
    value,
    onSelect,
    icon: Icon,
    trailing,
    children,
}: {
    value: string;
    onSelect: () => void;
    icon: LucideIcon;
    trailing?: ReactNode;
    children: ReactNode;
}) {
    return (
        <Command.Item
            value={value}
            onSelect={onSelect}
            className="group relative flex cursor-default select-none items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] text-foreground outline-none data-[selected=true]:bg-accent"
        >
            <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate leading-tight">{children}</span>
            {trailing}
        </Command.Item>
    );
}
