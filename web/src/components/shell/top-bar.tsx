import { useLocation } from "react-router";
import { Command, LoaderCircle, PanelLeft, Search, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip } from "@/components/ui/tooltip";
import { AccountMenu } from "./account-menu";
import { useShellData } from "./shell-data";
import { useUploads } from "@/components/recordings/uploads";

/** Opens the command palette, which the library page mounts (spec/ui-library.md 4). */
export const OPEN_COMMAND_PALETTE_EVENT = "oah:open-command-palette";

/** The page title for the path, as spec/ui-app.md 1.4 lists it. */
export function pageTitle(pathname: string): string | null {
    if (pathname === "/dashboard") return "Dashboard";
    if (pathname === "/recordings" || pathname.startsWith("/recordings/") || pathname === "/dev/demo-dashboard") return "Library";
    if (pathname === "/settings" || pathname.startsWith("/settings/")) return "Settings";
    return null;
}

export interface TopBarProps {
    sidebarOpen: boolean;
    onToggleSidebar: () => void;
}

/** The sticky top bar: sidebar toggle, page title, search, upload and the account menu. */
export function TopBar({ sidebarOpen, onToggleSidebar }: TopBarProps) {
    const { pathname } = useLocation();
    const title = pageTitle(pathname);

    return (
        <header
            data-testid="topbar"
            className="sticky top-0 z-30 flex h-[52px] shrink-0 items-center gap-2 border-b border-border bg-background/70 pl-3 pr-3 backdrop-blur supports-[backdrop-filter]:bg-background/70 sm:pr-4"
        >
            <Tooltip content="Toggle sidebar">
                <Button variant="ghost" size="icon" className="sm:size-9 md:size-7" aria-label="Toggle Sidebar" aria-expanded={sidebarOpen} onClick={onToggleSidebar}>
                    <PanelLeft />
                </Button>
            </Tooltip>
            {title ? <span className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-tight">{title}</span> : <span className="flex-1" />}

            {pathname === "/recordings" ? <CommandTrigger /> : null}
            {pathname !== "/recordings" ? <ToolbarSearch /> : null}
            <UploadButton />
            <AccountMenu />
        </header>
    );
}

function CommandTrigger() {
    return (
        <div className="hidden md:block">
            <Tooltip content="Search recordings, transcripts, and actions">
                <Button
                    data-testid="command-trigger"
                    variant="secondary"
                    size="sm"
                    aria-label="Open command palette"
                    className="h-8 gap-1.5 rounded-lg bg-muted px-2.5 font-medium text-muted-foreground hover:text-foreground"
                    onClick={() => window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE_EVENT))}
                >
                    <Command aria-hidden="true" className="size-4" />
                    <span className="hidden lg:inline">Search</span>
                    <Kbd className="ml-auto hidden lg:inline-flex">⌘K</Kbd>
                </Button>
            </Tooltip>
        </div>
    );
}

/** A GET form to /recordings?q=. Shown from 1024 px up on pages other than the library. */
function ToolbarSearch() {
    return (
        <div className="hidden lg:block">
            <form data-testid="toolbar-search" role="search" action="/recordings" method="get" className="relative w-56">
                <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <input
                    type="search"
                    name="q"
                    aria-label="Search recordings"
                    placeholder="Search"
                    className="h-8 w-full rounded-lg bg-secondary pl-8 pr-3 text-[13px] text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
            </form>
        </div>
    );
}

function UploadButton() {
    const { recordings, openUploadPicker } = useShellData();
    const { busy: uploading } = useUploads();
    const processing = recordings?.some((r) => r.processing !== null) ?? false;
    const busy = uploading || processing;
    return (
        <Tooltip content="Upload an audio file from your computer">
            <Button
                data-testid="upload-button"
                variant="primary"
                size="sm"
                aria-label={uploading ? "Uploading audio" : "Upload audio"}
                disabled={busy}
                className="gap-1.5 rounded-md has-[>svg]:px-2.5 sm:h-8"
                onClick={openUploadPicker}
            >
                {uploading ? (
                    <LoaderCircle className="motion-safe:animate-spin sm:mr-2" aria-hidden="true" />
                ) : (
                    <Upload aria-hidden="true" className="sm:mr-2" />
                )}
                <span className="hidden sm:inline">{uploading ? "Uploading…" : "Upload"}</span>
            </Button>
        </Tooltip>
    );
}
