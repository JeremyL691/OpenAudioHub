import type { TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import { fieldBase } from "./input";
import { useFieldContext } from "./field";

export function Textarea({ className, id, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
    const field = useFieldContext();
    return (
        <textarea
            id={id ?? field?.id}
            aria-describedby={props["aria-describedby"] ?? field?.describedBy}
            aria-invalid={props["aria-invalid"] ?? (field?.invalid || undefined)}
            className={cn(fieldBase, "h-auto min-h-20 py-2 leading-6", className)}
            {...props}
        />
    );
}
