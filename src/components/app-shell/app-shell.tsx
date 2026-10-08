"use client";

import type { ReactNode } from "react";
import { AppDialogs } from "@/components/app-shell/app-dialogs";
import { AppSidebar } from "@/components/app-shell/app-sidebar";
import { MiniPlayerHost } from "@/components/app-shell/mini-player-slot";
import { TopBar } from "@/components/app-shell/top-bar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";

interface AppShellProps {
    userEmail: string | null;
    initialTheme: "light" | "dark" | "system";
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
    sidebarFooter,
    children,
}: AppShellProps) {
    return (
        <SidebarProvider>
            <AppSidebar footer={sidebarFooter} />
            <SidebarInset>
                <TopBar userEmail={userEmail} initialTheme={initialTheme} />
                <MiniPlayerHost>
                    <div className="flex flex-1 flex-col">{children}</div>
                </MiniPlayerHost>
            </SidebarInset>
            <AppDialogs />
        </SidebarProvider>
    );
}
