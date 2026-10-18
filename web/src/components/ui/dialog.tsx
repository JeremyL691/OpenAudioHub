import type { ComponentProps, HTMLAttributes } from "react";
import { Dialog as D } from "radix-ui";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "./button";

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;
export const DialogPortal = D.Portal;

export function DialogOverlay({ className, ...props }: ComponentProps<typeof D.Overlay>) {
    return <D.Overlay className={cn("fixed inset-0 z-50 bg-foreground/20", className)} {...props} />;
}

export interface DialogContentProps extends ComponentProps<typeof D.Content> {
    /** Leaves out the corner close button (the command palette closes with Escape only). */
    hideClose?: boolean;
}

/** Centered dialog with a close button. Escape and outside clicks close it unless the caller stops them. */
export function DialogContent({ className, children, hideClose = false, ...props }: DialogContentProps) {
    return (
        <DialogPortal>
            <DialogOverlay />
            <D.Content
                className={cn(
                    "fixed left-1/2 top-1/2 z-50 grid w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 rounded-2xl bg-popover p-7 text-popover-foreground focus:outline-none",
                    className,
                )}
                {...props}
            >
                {children}
                {hideClose ? null : (
                    <D.Close asChild>
                        <Button variant="ghost" size="icon" aria-label="Close" className="absolute right-3 top-3">
                            <X />
                        </Button>
                    </D.Close>
                )}
            </D.Content>
        </DialogPortal>
    );
}

export function DialogTitle({ className, ...props }: ComponentProps<typeof D.Title>) {
    return <D.Title className={cn("text-[15px] font-semibold leading-none", className)} {...props} />;
}

export function DialogDescription({ className, ...props }: ComponentProps<typeof D.Description>) {
    return <D.Description className={cn("text-[13px] text-muted-foreground", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
    return <div className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} {...props} />;
}
