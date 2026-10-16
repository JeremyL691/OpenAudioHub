"use client";

import type { LucideIcon } from "lucide-react";
import type * as React from "react";
import { createContext, useContext } from "react";
import type { SettingsTile } from "@/components/settings-nav-config";
import { cn } from "@/lib/utils";

/**
 * Tile colour of the section being shown. The settings page provides it from
 * the nav item, so each pane's icon matches its sidebar tile.
 */
export const SettingsTileContext = createContext<SettingsTile>("bg-tile-gray");

interface SectionHeaderProps {
    title: React.ReactNode;
    description?: React.ReactNode;
    /** Icon shown on the section's 40px tile. Pass `null` to skip the tile. */
    icon?: LucideIcon | null;
    /** Slot rendered in the top-right (e.g. an "Add" button). */
    action?: React.ReactNode;
    className?: string;
}

/**
 * Standardized page header for every settings section: a 40px tile with the
 * section icon, the title, and a one-line description, as in the macOS System
 * Settings panes.
 */
export function SettingsSectionHeader({
    title,
    description,
    icon: Icon,
    action,
    className,
}: SectionHeaderProps) {
    const tile = useContext(SettingsTileContext);
    return (
        <div
            className={cn("flex items-start justify-between gap-4", className)}
        >
            <div className="flex min-w-0 flex-1 items-center gap-3">
                {Icon && (
                    <div
                        className={cn(
                            "flex size-10 shrink-0 items-center justify-center rounded-xl",
                            tile,
                        )}
                        aria-hidden="true"
                    >
                        <Icon className="size-5 text-primary-foreground" />
                    </div>
                )}
                <div className="min-w-0">
                    <h2 className="text-[22px] font-bold tracking-tight">
                        {title}
                    </h2>
                    {description && (
                        <p className="mt-0.5 text-[13px] text-muted-foreground">
                            {description}
                        </p>
                    )}
                </div>
            </div>
            {action && <div className="shrink-0">{action}</div>}
        </div>
    );
}
