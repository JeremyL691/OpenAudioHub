"use client";

import {
    AudioLines,
    BookOpen,
    Clock,
    LayoutGrid,
    type LucideIcon,
    Mic,
    Settings,
    Star,
    Upload,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
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
    SidebarGroupLabel,
    SidebarHeader,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
} from "@/components/ui/sidebar";
import {
    COLLECTIONS,
    type CollectionCounts,
    type CollectionId,
} from "@/lib/recordings/collections";
import { APP_RELEASE_URL, APP_VERSION_TAG } from "@/lib/version";

const COLLECTION_ICONS: Record<CollectionId, LucideIcon> = {
    starred: Star,
    recent: Clock,
    plaud: Mic,
    uploaded: Upload,
};

const LIBRARY_PREFIXES = ["/recordings", "/dev/demo-dashboard"];

function matchesPrefix(pathname: string, prefixes: string[]): boolean {
    return prefixes.some(
        (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    );
}

function NavItem({
    href,
    label,
    icon: Icon,
    testId,
    active,
    count,
}: {
    href: string;
    label: string;
    icon: LucideIcon;
    testId: string;
    active: boolean;
    count?: number;
}) {
    return (
        <SidebarMenuItem>
            <SidebarMenuButton
                asChild
                isActive={active}
                className="h-10 gap-2.5 rounded-md px-2.5 text-[13px] data-[active=true]:bg-sidebar-accent data-[active=true]:font-semibold md:h-8 [&[data-active=true]>svg]:text-primary"
            >
                <Link
                    href={href}
                    data-testid={testId}
                    aria-current={active ? "page" : undefined}
                >
                    <Icon />
                    <span>{label}</span>
                    {count !== undefined && (
                        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                            {count}
                        </span>
                    )}
                </Link>
            </SidebarMenuButton>
        </SidebarMenuItem>
    );
}

/**
 * Primary navigation for the signed-in app.
 * Desktop collapses it off-canvas; below md it opens as a sheet.
 */
export function AppSidebar({
    counts,
    footer,
}: {
    counts: CollectionCounts;
    footer: ReactNode;
}) {
    const pathname = usePathname();
    const collection = useSearchParams().get("collection");
    const onLibrary = pathname === "/recordings";

    return (
        <Sidebar collapsible="offcanvas" data-testid="app-sidebar">
            <SidebarHeader className="app-drag gap-0 p-0">
                <div className="desktop-only h-13" />
                <div className="px-4 pb-3">
                    <div className="web-only h-4" />
                    <Link
                        href="/dashboard"
                        aria-label="OpenAudioHub home"
                        className="w-fit"
                    >
                        <Logo className="text-base" />
                    </Link>
                </div>
            </SidebarHeader>
            <SidebarContent>
                <SidebarGroup>
                    <SidebarGroupContent>
                        <SidebarMenu>
                            <NavItem
                                href="/dashboard"
                                label="Dashboard"
                                icon={LayoutGrid}
                                testId="nav-overview"
                                active={matchesPrefix(pathname, ["/dashboard"])}
                            />
                            <NavItem
                                href="/recordings"
                                label="Library"
                                icon={AudioLines}
                                testId="nav-recordings"
                                active={
                                    matchesPrefix(pathname, LIBRARY_PREFIXES) &&
                                    collection === null
                                }
                                count={counts.all}
                            />
                        </SidebarMenu>
                    </SidebarGroupContent>
                </SidebarGroup>
                <SidebarGroup>
                    <SidebarGroupLabel className="h-auto px-2.5 pt-4 text-[11px] font-semibold text-muted-foreground">
                        Collections
                    </SidebarGroupLabel>
                    <SidebarGroupContent>
                        <SidebarMenu>
                            {COLLECTIONS.map((item) => (
                                <NavItem
                                    key={item.id}
                                    href={`/recordings?collection=${item.id}`}
                                    label={item.label}
                                    icon={COLLECTION_ICONS[item.id]}
                                    testId={`nav-collection-${item.id}`}
                                    active={onLibrary && collection === item.id}
                                    count={counts[item.id]}
                                />
                            ))}
                        </SidebarMenu>
                    </SidebarGroupContent>
                </SidebarGroup>
            </SidebarContent>
            <SidebarFooter className="gap-3 px-4 py-3 text-[11px] text-muted-foreground">
                <SidebarMenu className="-mx-2">
                    <NavItem
                        href="/settings"
                        label="Settings"
                        icon={Settings}
                        testId="nav-settings"
                        active={matchesPrefix(pathname, ["/settings"])}
                    />
                    <NavItem
                        href="/docs"
                        label="Docs"
                        icon={BookOpen}
                        testId="nav-docs"
                        active={matchesPrefix(pathname, ["/docs"])}
                    />
                </SidebarMenu>
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
