"use client";

import Link from "next/link";
import { useState } from "react";
import { useDesktopMode } from "@/components/desktop-mode-provider";
import {
    type NavItem,
    visibleSettingsNavGroups,
} from "@/components/settings-nav-config";
import { cn } from "@/lib/utils";
import type { SettingsSection } from "@/types/settings";

interface Props {
    activeSection: SettingsSection;
}

function matchesQuery(item: NavItem, query: string): boolean {
    return (
        item.name.toLowerCase().includes(query) ||
        item.keywords.some((keyword) => keyword.includes(query))
    );
}

/**
 * Desktop section list in the System Settings style. Each item is a real link
 * to `/settings/<id>`, so the section is in the address bar. Hidden below lg,
 * where the section picker in the page header takes over.
 */
export function SettingsNavSidebar({ activeSection }: Props) {
    const desktop = useDesktopMode();
    const [query, setQuery] = useState("");
    const normalized = query.trim().toLowerCase();
    const groups = visibleSettingsNavGroups(desktop)
        .map((group) => ({
            ...group,
            items: normalized
                ? group.items.filter((item) => matchesQuery(item, normalized))
                : group.items,
        }))
        .filter((group) => group.items.length > 0);

    return (
        <nav
            aria-label="Settings sections"
            data-testid="settings-nav"
            className="hidden w-60 shrink-0 flex-col overflow-y-auto border-r border-border bg-sidebar p-3 lg:flex"
        >
            <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search settings"
                aria-label="Search settings"
                data-testid="settings-search"
                className="h-8 w-full rounded-lg bg-secondary px-2.5 text-[13px] placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            />
            {groups.length === 0 && (
                <p className="mt-3 px-2 text-[13px] text-muted-foreground">
                    No results
                </p>
            )}
            {groups.map((group) => (
                <div key={group.label} className="mt-3 flex flex-col gap-0.5">
                    {group.items.map((item) => {
                        const active = activeSection === item.id;
                        return (
                            <Link
                                key={item.id}
                                href={`/settings/${item.id}`}
                                aria-label={`${item.name} settings`}
                                aria-current={active ? "page" : undefined}
                                className={cn(
                                    "flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] text-foreground transition-colors hover:bg-accent",
                                    active &&
                                        "bg-primary font-medium text-primary-foreground hover:bg-primary",
                                    !active &&
                                        item.id === "dev" &&
                                        "text-destructive",
                                )}
                            >
                                <span
                                    className={cn(
                                        "flex size-[22px] shrink-0 items-center justify-center rounded-md",
                                        item.tile,
                                    )}
                                    aria-hidden="true"
                                >
                                    <item.icon className="size-3.5 text-primary-foreground" />
                                </span>
                                <span>{item.name}</span>
                            </Link>
                        );
                    })}
                </div>
            ))}
        </nav>
    );
}
