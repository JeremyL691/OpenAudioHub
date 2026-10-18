import type { ComponentProps } from "react";
import { Tabs as T } from "radix-ui";
import { cn } from "@/lib/cn";

export const Tabs = T.Root;

export function TabsList({ className, ...props }: ComponentProps<typeof T.List>) {
    return <T.List className={cn("inline-flex gap-0.5 rounded-lg bg-secondary p-0.5", className)} {...props} />;
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof T.Trigger>) {
    return (
        <T.Trigger
            className={cn(
                "inline-flex h-8 items-center justify-center rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors duration-150 ease-out motion-reduce:transition-none hover:text-foreground data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-card",
                className,
            )}
            {...props}
        />
    );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof T.Content>) {
    return <T.Content className={cn("focus-visible:outline-none", className)} {...props} />;
}
