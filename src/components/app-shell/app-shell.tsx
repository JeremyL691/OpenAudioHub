"use client";

import type { ReactNode } from "react";
import { AppDialogs } from "@/components/app-shell/app-dialogs";
import { AppSidebar } from "@/components/app-shell/app-sidebar";
import { MiniPlayerHost } from "@/components/app-shell/mini-player-slot";
import { TopBar } from "@/components/app-shell/top-bar";
import { useDesktopMode } from "@/components/desktop-mode-provider";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import type { CollectionCounts } from "@/lib/recordings/collections";
import { cn } from "@/lib/utils";

interface AppShellProps {
    userEmail: string | null;
    initialTheme: "light" | "dark" | "system";
    /** Recording counts for the sidebar collections. */
    counts: CollectionCounts;
    /** Server-rendered sidebar footer content (update notice, license line). */
    sidebarFooter: ReactNode;
    children: ReactNode;
}

/**
 * Chrome around every authenticated page: sidebar, top bar, and the global
 * dialogs. Must render inside AppShellProviders.
 */
export function AppShell({
    userEmail,
    initialTheme,
    counts,
    sidebarFooter,
    children,
}: AppShellProps) {
    const desktop = useDesktopMode();
    return (
        <SidebarProvider>
            <AppSidebar counts={counts} footer={sidebarFooter} />
            <SidebarInset
                className={cn(
                    "min-w-0 [--titlebar-inset:0px]",
                    desktop &&
                        "[--titlebar-inset:4.5rem] md:[--titlebar-inset:0px] md:peer-data-[state=collapsed]:[--titlebar-inset:4.5rem]",
                )}
            >
                <TopBar userEmail={userEmail} initialTheme={initialTheme} />
                <MiniPlayerHost>
                    <div className="flex flex-1 flex-col">{children}</div>
                </MiniPlayerHost>
            </SidebarInset>
            <AppDialogs />
        </SidebarProvider>
    );
}
