"use client";

import {
    AudioLines,
    BookOpen,
    LayoutDashboard,
    type LucideIcon,
    Settings,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Github } from "@/components/icons/icons";
import { Logo } from "@/components/icons/logo";
import { ReportBugButton } from "@/components/report-bug-dialog";
import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarGroup,
    SidebarGroupContent,
    SidebarHeader,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
} from "@/components/ui/sidebar";
import { APP_RELEASE_URL, APP_VERSION_TAG } from "@/lib/version";

interface NavItem {
    href: string;
    label: string;
    icon: LucideIcon;
    testId: string;
    /** Path prefixes that mark this item as active. */
    prefixes: string[];
}

const NAV_ITEMS: NavItem[] = [
    {
        href: "/dashboard",
        label: "Overview",
        icon: LayoutDashboard,
        testId: "nav-overview",
        prefixes: ["/dashboard"],
    },
    {
        href: "/recordings",
        label: "Recordings",
        icon: AudioLines,
        testId: "nav-recordings",
        prefixes: ["/recordings", "/dev/demo-dashboard"],
    },
    {
        href: "/settings",
        label: "Settings",
        icon: Settings,
        testId: "nav-settings",
        prefixes: ["/settings"],
    },
    {
        href: "/docs",
        label: "Docs",
        icon: BookOpen,
        testId: "nav-docs",
        prefixes: ["/docs"],
    },
];

function matchesPrefix(pathname: string, prefixes: string[]): boolean {
    return prefixes.some(
        (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    );
}

/**
 * Primary navigation for the signed-in app. Overview is not listed yet: its
 * page arrives with T5.1, and a link that repeats Recordings would mislead.
 * Desktop collapses it off-canvas; below md it opens as a sheet.
 */
export function AppSidebar({ footer }: { footer: ReactNode }) {
    const pathname = usePathname();

    return (
        <Sidebar collapsible="offcanvas" data-testid="app-sidebar">
            <SidebarHeader className="px-4 py-4">
                <Link
                    href="/dashboard"
                    aria-label="OpenAudioHub home"
                    className="w-fit"
                >
                    <Logo className="text-base" />
                </Link>
            </SidebarHeader>
            <SidebarContent>
                <SidebarGroup>
                    <SidebarGroupContent>
                        <SidebarMenu>
                            {NAV_ITEMS.map((item) => (
                                <SidebarMenuItem key={item.href}>
                                    <SidebarMenuButton
                                        asChild
                                        isActive={matchesPrefix(
                                            pathname,
                                            item.prefixes,
                                        )}
                                        className="h-10 md:h-8"
                                    >
                                        <Link
                                            href={item.href}
                                            data-testid={item.testId}
                                        >
                                            <item.icon />
                                            <span>{item.label}</span>
                                        </Link>
                                    </SidebarMenuButton>
                                </SidebarMenuItem>
                            ))}
                        </SidebarMenu>
                    </SidebarGroupContent>
                </SidebarGroup>
            </SidebarContent>
            <SidebarFooter className="gap-3 px-4 py-3 text-xs text-muted-foreground">
                {footer}
                <div className="flex items-center gap-3 font-mono">
                    <Link
                        href={APP_RELEASE_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`Release notes for OpenAudioHub ${APP_VERSION_TAG}`}
                        className="transition-colors hover:text-foreground"
                    >
                        {APP_VERSION_TAG}
                    </Link>
                    <ReportBugButton className="transition-colors hover:text-foreground" />
                    <Link
                        href="https://github.com/JeremyL691/OpenAudioHub"
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label="View source code on GitHub"
                        className="transition-colors hover:text-foreground"
                    >
                        <Github className="size-4" />
                    </Link>
                </div>
            </SidebarFooter>
        </Sidebar>
    );
}
