import type { InputHTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import { useFieldContext } from "./field";

/** Shared field look, also used by Textarea and Select. */
export const fieldBase =
    "w-full min-w-0 rounded-lg border border-input bg-background px-3 text-sm text-foreground shadow-none transition-colors duration-150 ease-out placeholder:text-muted-foreground h-10 sm:h-8 focus-visible:border-ring aria-invalid:border-destructive disabled:cursor-not-allowed disabled:opacity-50";

export function Input({ className, id, ...props }: InputHTMLAttributes<HTMLInputElement>) {
    const field = useFieldContext();
    return (
        <input
            id={id ?? field?.id}
            aria-describedby={props["aria-describedby"] ?? field?.describedBy}
            aria-invalid={props["aria-invalid"] ?? (field?.invalid || undefined)}
            className={cn(fieldBase, className)}
            {...props}
        />
    );
}
