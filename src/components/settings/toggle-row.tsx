"use client";

import type * as React from "react";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

interface ToggleRowProps {
    id: string;
    label: React.ReactNode;
    description?: React.ReactNode;
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
    disabled?: boolean;
    /**
     * When set, the whole row is wrapped as a label-for clickable area
     * so the user can hit anywhere on the row to toggle. Defaults to
     * true — set false if the row contains nested interactive children.
     */
    rowClickable?: boolean;
    className?: string;
}

/**
 * Standardized "label + description + switch" row.
 *
 * Two improvements over the ad-hoc inline pattern this replaces:
 *
 *   1. The whole row is wrapped in `<label htmlFor>`, so clicking the
 *      description (not just the tiny switch) toggles. Big tap target,
 *      better readability, fewer rage-clicks at the switch.
 *   2. Row height and label styles are uniform across every settings
 *      section that uses it, so the grouped lists keep one rhythm.
 */
export function ToggleRow({
    id,
    label,
    description,
    checked,
    onCheckedChange,
    disabled = false,
    rowClickable = true,
    className,
}: ToggleRowProps) {
    const labelBlock = (
        <div className="min-w-0 flex-1">
            <span
                className={cn(
                    "block text-[13px] font-medium",
                    disabled && "opacity-60",
                )}
            >
                {label}
            </span>
            {description && (
                <span className="mt-0.5 block text-xs text-muted-foreground">
                    {description}
                </span>
            )}
        </div>
    );

    const switchEl = (
        <Switch
            id={id}
            checked={checked}
            onCheckedChange={onCheckedChange}
            disabled={disabled}
        />
    );

    const row = (
        <div
            className={cn(
                "flex min-h-11 items-center justify-between gap-4 py-2.5",
                rowClickable && !disabled && "cursor-pointer",
                className,
            )}
        >
            {labelBlock}
            {switchEl}
        </div>
    );

    if (!rowClickable) return row;

    return (
        // `<label>` wrapping a Switch already routes a click on the
        // label to the input via htmlFor. We use the wrapping label
        // form so the whole row, including the description text, is a
        // single tap target.
        <label htmlFor={id} className="block">
            {row}
        </label>
    );
}
