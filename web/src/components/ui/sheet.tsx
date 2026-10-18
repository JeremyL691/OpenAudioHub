import type { ComponentProps } from "react";
import { Dialog as D } from "radix-ui";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "./button";
import { DialogDescription, DialogOverlay, DialogPortal, DialogTitle } from "./dialog";

/** A side drawer built on Dialog. Used for the sidebar below 768 px. */
export const Sheet = D.Root;
export const SheetTrigger = D.Trigger;
export const SheetClose = D.Close;
export const SheetTitle = DialogTitle;
export const SheetDescription = DialogDescription;

export interface SheetContentProps extends ComponentProps<typeof D.Content> {
    side?: "left" | "right";
    /** Leaves out the corner close button. Escape and the overlay still close the sheet. */
    hideClose?: boolean;
}

export function SheetContent({ side = "left", className, children, hideClose = false, ...props }: SheetContentProps) {
    return (
        <DialogPortal>
            <DialogOverlay />
            <D.Content
                className={cn(
                    "fixed inset-y-0 z-50 flex h-full w-72 max-w-[85vw] flex-col gap-4 overflow-y-auto bg-sidebar p-5 text-foreground shadow-card focus:outline-none",
                    side === "left" ? "left-0" : "right-0",
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
