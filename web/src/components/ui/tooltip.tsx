import type { ReactElement, ReactNode } from "react";
import { Tooltip as T } from "radix-ui";

export interface TooltipProps {
    /** The text shown on hover and focus. It is also the trigger's accessible description. */
    content: ReactNode;
    side?: "top" | "right" | "bottom" | "left";
    /** A single focusable element, such as a Button. */
    children: ReactElement;
}

export function Tooltip({ content, side = "top", children }: TooltipProps) {
    return (
        <T.Provider delayDuration={300}>
            <T.Root>
                <T.Trigger asChild>{children}</T.Trigger>
                <T.Portal>
                    <T.Content
                        side={side}
                        sideOffset={6}
                        className="z-50 rounded-md bg-foreground px-2 py-1 text-xs text-background"
                    >
                        {content}
                    </T.Content>
                </T.Portal>
            </T.Root>
        </T.Provider>
    );
}
