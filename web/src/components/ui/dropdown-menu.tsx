import type { ComponentProps } from "react";
import { DropdownMenu as M } from "radix-ui";
import { Circle } from "lucide-react";
import { cn } from "@/lib/cn";

export const DropdownMenu = M.Root;
export const DropdownMenuTrigger = M.Trigger;
export const DropdownMenuGroup = M.Group;
export const DropdownMenuRadioGroup = M.RadioGroup;

/** The menu panel. Its default padding is 4 px; a caller that lays out its own sections passes className="p-0". */
export function DropdownMenuContent({ className, sideOffset = 6, ...props }: ComponentProps<typeof M.Content>) {
    return (
        <M.Portal>
            <M.Content
                sideOffset={sideOffset}
                className={cn(
                    "z-50 min-w-[10rem] overflow-hidden rounded-xl border border-border/60 bg-popover p-1 text-popover-foreground shadow-lg focus:outline-none",
                    className,
                )}
                {...props}
            />
        </M.Portal>
    );
}

/** A menu row with an icon slot (16 px icons). Pass variant="destructive" for a destructive action. */
export function DropdownMenuItem({ className, variant, ...props }: ComponentProps<typeof M.Item> & { variant?: "default" | "destructive" }) {
    return (
        <M.Item
            className={cn(
                "relative flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-[13px] outline-none transition-colors data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
                variant === "destructive"
                    ? "text-destructive data-[highlighted]:bg-destructive data-[highlighted]:text-destructive-foreground"
                    : "text-foreground data-[highlighted]:bg-primary data-[highlighted]:text-primary-foreground",
                className,
            )}
            {...props}
        />
    );
}

/** A theme-style choice row: a dot marks the checked item. */
export function DropdownMenuRadioItem({ className, children, ...props }: ComponentProps<typeof M.RadioItem>) {
    return (
        <M.RadioItem
            className={cn(
                "relative flex cursor-default select-none items-center rounded-md py-1.5 pl-8 pr-2 text-[13px] text-foreground outline-none transition-colors data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-primary data-[highlighted]:text-primary-foreground [&_svg]:shrink-0",
                className,
            )}
            {...props}
        >
            <span className="absolute left-2 flex size-3.5 items-center justify-center">
                <M.ItemIndicator>
                    <Circle className="size-2 fill-current" />
                </M.ItemIndicator>
            </span>
            {children}
        </M.RadioItem>
    );
}

export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof M.Label>) {
    return <M.Label className={cn("px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground", className)} {...props} />;
}

export function DropdownMenuSeparator({ className, ...props }: ComponentProps<typeof M.Separator>) {
    return <M.Separator className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />;
}
