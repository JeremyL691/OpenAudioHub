import type { ComponentProps } from "react";
import { AlertDialog as A } from "radix-ui";
import { cn } from "@/lib/cn";

/** Confirmation dialog. It does not close on outside click. Use Button asChild inside Cancel and Action. */
export const AlertDialog = A.Root;
export const AlertDialogTrigger = A.Trigger;
export const AlertDialogCancel = A.Cancel;
export const AlertDialogAction = A.Action;

export function AlertDialogContent({ className, ...props }: ComponentProps<typeof A.Content>) {
    return (
        <A.Portal>
            <A.Overlay className="fixed inset-0 z-50 bg-foreground/20" />
            <A.Content
                className={cn(
                    "fixed left-1/2 top-1/2 z-50 grid w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 rounded-2xl bg-popover p-7 text-popover-foreground focus:outline-none",
                    className,
                )}
                {...props}
            />
        </A.Portal>
    );
}

export function AlertDialogTitle({ className, ...props }: ComponentProps<typeof A.Title>) {
    return <A.Title className={cn("text-[15px] font-semibold leading-none", className)} {...props} />;
}

export function AlertDialogDescription({ className, ...props }: ComponentProps<typeof A.Description>) {
    return <A.Description className={cn("text-[13px] text-muted-foreground", className)} {...props} />;
}

export function AlertDialogFooter({ className, ...props }: ComponentProps<"div">) {
    return <div className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} {...props} />;
}
