"use client";

import type { LucideIcon } from "lucide-react";
import type * as React from "react";
import { cn } from "@/lib/utils";

interface SettingsCardProps {
    /**
     * Optional group label, shown above the group. When absent, the group
     * renders without a label; the children handle their own structure
     * (useful when a subsystem only has a single setting and a title would
     * feel like noise).
     */
    title?: React.ReactNode;
    /** Optional short description rendered under the label. */
    description?: React.ReactNode;
    /** Optional icon shown next to the label at a restrained size. */
    icon?: LucideIcon;
    /** Slot rendered at the right of the label row (e.g. a Switch). */
    action?: React.ReactNode;
    children: React.ReactNode;
    className?: string;
}

/**
 * Grouped-list primitive for settings sections, in the System Settings
 * style: a small muted label sits above a rounded, tinted group that holds
 * the rows. Rows (such as `ToggleRow`) provide their own vertical padding.
 */
export function SettingsCard({
    title,
    description,
    icon: Icon,
    action,
    children,
    className,
}: SettingsCardProps) {
    return (
        <div className={cn("flex flex-col gap-1.5", className)}>
            {(title || description || action) && (
                <div className="flex items-end justify-between gap-4 px-1">
                    <div className="min-w-0 flex-1">
                        {title && (
                            <div className="flex items-center gap-1.5 text-[13px] font-semibold text-muted-foreground">
                                {Icon && (
                                    <Icon
                                        className="size-4"
                                        aria-hidden="true"
                                    />
                                )}
                                <span>{title}</span>
                            </div>
                        )}
                        {description && (
                            <p className="mt-0.5 text-xs text-muted-foreground">
                                {description}
                            </p>
                        )}
                    </div>
                    {action && <div className="shrink-0">{action}</div>}
                </div>
            )}
            <div className="rounded-xl bg-muted/60 px-4 py-1 dark:bg-muted">
                {children}
            </div>
        </div>
    );
}
