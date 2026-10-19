import { useEffect, useState, useSyncExternalStore } from "react";
import { Outlet } from "react-router";
import { RequireSession } from "@/lib/session";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import { MiniPlayer } from "@/components/player/mini-player";
import { KeyboardShortcuts } from "@/components/player/shortcuts";
import { PlayerProvider } from "@/components/player/player-context";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { CommandPalette } from "./command-palette";
import { OnboardingDialog } from "./onboarding-dialog";
import { SidebarNav } from "./sidebar-nav";
import { ShellDataProvider } from "./shell-data";
import { TopBar } from "./top-bar";

const SIDEBAR_COOKIE = "sidebar_state";
const SEVEN_DAYS = 7 * 24 * 60 * 60;

/** Reads the docked sidebar state from its cookie. Expanded when nothing is stored. */
function readSidebarCookie(): boolean {
    const match = document.cookie.match(/(?:^|;\s*)sidebar_state=([^;]*)/);
    return match ? match[1] !== "false" : true;
}

function useMediaQuery(query: string): boolean {
    return useSyncExternalStore(
        (notify) => {
            const list = window.matchMedia(query);
            list.addEventListener("change", notify);
            return () => list.removeEventListener("change", notify);
        },
        () => window.matchMedia(query).matches,
        () => true,
    );
}

/** The signed-in frame: sidebar, top bar and the page outlet. Mounts the player and shortcuts once. */
export default function Shell() {
    return (
        <RequireSession>
            <PlayerProvider>
                <ShellDataProvider>
                    <ShellFrame />
                </ShellDataProvider>
            </PlayerProvider>
        </RequireSession>
    );
}

function ShellFrame() {
    const { t } = useI18n();
    // 768 px and up (md): the sidebar is docked. Below it, the sidebar is a sheet.
    const docked = useMediaQuery("(min-width: 768px)");
    const [expanded, setExpanded] = useState(readSidebarCookie);
    const [sheetOpen, setSheetOpen] = useState(false);

    useEffect(() => {
        document.cookie = `${SIDEBAR_COOKIE}=${expanded}; path=/; max-age=${SEVEN_DAYS}; samesite=lax`;
    }, [expanded]);

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "b") return;
            event.preventDefault();
            if (docked) setExpanded((v) => !v);
            else setSheetOpen((v) => !v);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [docked]);

    const toggle = () => {
        if (docked) setExpanded((v) => !v);
        else setSheetOpen((v) => !v);
    };

    return (
        // Phones scroll the whole page (native feel, collapsing browser bars); wider screens keep a
        // fixed frame so the library panes can scroll on their own.
        <div className="flex min-h-dvh bg-background text-foreground md:h-dvh">
            {/* Docked: the sidebar slides closed (width 200 ms) and stays mounted, hidden from view and focus. */}
            {docked ? (
                <div
                    className={cn(
                        "sticky top-0 h-dvh shrink-0 overflow-hidden transition-[width] duration-200 ease-linear motion-reduce:transition-none",
                        expanded ? "w-64" : "w-0",
                    )}
                >
                    <div inert={!expanded} className={cn("h-dvh w-64 border-r border-border bg-sidebar", !expanded && "invisible")}>
                        <SidebarNav />
                    </div>
                </div>
            ) : null}
            {!docked ? (
                <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
                    <SheetContent side="left" className="gap-0 p-0">
                        <SheetTitle className="sr-only">{t("shell.nav.sidebar")}</SheetTitle>
                        <div className="h-full">
                            <SidebarNav onNavigate={() => setSheetOpen(false)} />
                        </div>
                    </SheetContent>
                </Sheet>
            ) : null}

            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <TopBar sidebarOpen={docked ? expanded : sheetOpen} onToggleSidebar={toggle} />
                <main className="flex min-h-0 min-w-0 flex-1 flex-col md:overflow-y-auto">
                    <div className="min-h-0 w-full flex-1 md:h-full">
                        <Outlet />
                    </div>
                </main>
            </div>

            <MiniPlayer />
            <KeyboardShortcuts />
            <CommandPalette />
            <OnboardingDialog />
        </div>
    );
}
