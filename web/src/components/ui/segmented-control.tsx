import type { ReactNode } from "react";
import { ToggleGroup as TG } from "radix-ui";
import { cn } from "@/lib/cn";

export interface SegmentedItem {
    value: string;
    label: ReactNode;
    /** Accessible name when the label is an icon. */
    "aria-label"?: string;
}

export interface SegmentedControlProps {
    value: string;
    onValueChange: (value: string) => void;
    items: SegmentedItem[];
    "aria-label": string;
    className?: string;
}

/** One choice out of a few, shown as a track with pills (radix ToggleGroup, single). Picking the active item is ignored. */
export function SegmentedControl({ value, onValueChange, items, className, ...aria }: SegmentedControlProps) {
    return (
        <TG.Root
            type="single"
            value={value}
            aria-label={aria["aria-label"]}
            onValueChange={(next) => {
                if (next) onValueChange(next);
            }}
            className={cn("inline-flex gap-0.5 rounded-lg bg-secondary p-0.5", className)}
        >
            {items.map((item) => (
                <TG.Item
                    key={item.value}
                    value={item.value}
                    aria-label={item["aria-label"]}
                    className="inline-flex h-8 items-center justify-center rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors duration-150 ease-out motion-reduce:transition-none hover:text-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-card"
                >
                    {item.label}
                </TG.Item>
            ))}
        </TG.Root>
    );
}
