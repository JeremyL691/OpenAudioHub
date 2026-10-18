import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

/** A keyboard hint. The only place monospace is used. */
export function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>) {
    return (
        <kbd
            className={cn(
                "inline-flex h-5 min-w-5 items-center justify-center gap-1 rounded border border-border bg-muted px-1.5 font-mono text-[11px] text-muted-foreground select-none",
                className,
            )}
            {...props}
        />
    );
}
