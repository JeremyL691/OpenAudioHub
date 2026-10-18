import type { ComponentProps } from "react";
import { Popover as P } from "radix-ui";
import { cn } from "@/lib/cn";

export const Popover = P.Root;
export const PopoverTrigger = P.Trigger;
export const PopoverAnchor = P.Anchor;
export const PopoverClose = P.Close;

export function PopoverContent({ className, sideOffset = 6, align = "center", ...props }: ComponentProps<typeof P.Content>) {
    return (
        <P.Portal>
            <P.Content
                sideOffset={sideOffset}
                align={align}
                className={cn("z-50 rounded-xl bg-popover p-4 text-popover-foreground shadow-card focus:outline-none", className)}
                {...props}
            />
        </P.Portal>
    );
}
