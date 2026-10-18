import type { ButtonHTMLAttributes } from "react";
import { Slot } from "radix-ui";
import { cn } from "@/lib/cn";

export type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "destructive" | "link";
export type ButtonSize = "sm" | "md" | "icon";

const base =
    "inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-colors duration-150 ease-out motion-reduce:transition-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0";

const variants: Record<ButtonVariant, string> = {
    primary: "bg-primary text-primary-foreground hover:bg-primary/90",
    secondary: "bg-secondary text-secondary-foreground hover:bg-accent",
    outline: "border border-border bg-background text-foreground hover:bg-accent",
    ghost: "text-foreground hover:bg-accent",
    destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
    link: "h-auto px-0 text-link underline-offset-4 hover:underline",
};

// Touch targets are 40 px tall below 640 px. From there up, buttons are 32 px tall with 14 px text.
const sizes: Record<ButtonSize, string> = {
    sm: "h-10 px-3 text-sm sm:h-8",
    md: "h-10 px-4 text-sm sm:h-8",
    icon: "size-10 sm:size-8",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: ButtonVariant;
    size?: ButtonSize;
    /** Renders the child element with the button classes (for example a router link). */
    asChild?: boolean;
}

export function Button({ variant = "secondary", size = "md", asChild = false, className, type, ...props }: ButtonProps) {
    const classes = cn(base, variants[variant], sizes[size], className);
    if (asChild) return <Slot.Root className={classes} {...props} />;
    return <button type={type ?? "button"} className={classes} {...props} />;
}
