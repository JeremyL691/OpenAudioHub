import type { ComponentProps } from "react";
import { Switch as S } from "radix-ui";
import { cn } from "@/lib/cn";

/** On/off toggle. Give it an id with a Label, or an aria-label. */
export function Switch({ className, ...props }: ComponentProps<typeof S.Root>) {
    return (
        <S.Root
            className={cn(
                "peer inline-flex h-[22px] w-[38px] shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-muted-foreground/30 outline-none transition-all duration-150 ease-out motion-reduce:transition-none data-[state=checked]:bg-primary focus-visible:ring-[3px] focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50",
                className,
            )}
            {...props}
        >
            <S.Thumb className="pointer-events-none block size-[18px] rounded-full bg-background shadow-sm ring-0 transition-transform duration-150 ease-out motion-reduce:transition-none data-[state=checked]:translate-x-[calc(100%-2px)] data-[state=unchecked]:translate-x-0" />
        </S.Root>
    );
}
