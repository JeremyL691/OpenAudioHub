"use client";

import * as SwitchPrimitive from "@radix-ui/react-switch";
import type * as React from "react";

import { cn } from "@/lib/utils";

function Switch({
    className,
    ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
    return (
        <SwitchPrimitive.Root
            data-slot="switch"
            className={cn(
                "peer data-[state=checked]:bg-primary data-[state=unchecked]:bg-muted-foreground/30 focus-visible:border-ring focus-visible:ring-ring/30 inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full border border-transparent shadow-none transition-all outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50",
                className,
            )}
            {...props}
        >
            <SwitchPrimitive.Thumb
                data-slot="switch-thumb"
                className={cn(
                    "bg-background shadow-sm pointer-events-none block size-[18px] rounded-full ring-0 transition-transform data-[state=checked]:translate-x-[calc(100%-2px)] data-[state=unchecked]:translate-x-0",
                )}
            />
        </SwitchPrimitive.Root>
    );
}

export { Switch };
