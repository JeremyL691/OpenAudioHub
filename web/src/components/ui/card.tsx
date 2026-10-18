import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

/** A raised surface with the card shadow. Cards do not nest. */
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
    return <div className={cn("rounded-2xl bg-card p-5 text-card-foreground shadow-card", className)} {...props} />;
}
