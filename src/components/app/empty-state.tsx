import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface EmptyStateProps {
    icon?: LucideIcon;
    title: string;
    description?: ReactNode;
    /** One next step, such as a button that starts the first action. */
    action?: ReactNode;
    className?: string;
}

/** Shown where a list or panel has nothing yet. Offers one next step when there is one. */
export function EmptyState({
    icon: Icon,
    title,
    description,
    action,
    className,
}: EmptyStateProps) {
    return (
        <div
            className={cn(
                "flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-10 text-center",
                className,
            )}
        >
            {Icon ? (
                <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
                    <Icon aria-hidden="true" className="size-5" />
                </span>
            ) : null}
            <div className="max-w-sm space-y-1">
                <h2 className="text-base font-semibold">{title}</h2>
                {description ? (
                    <p className="text-sm text-muted-foreground">
                        {description}
                    </p>
                ) : null}
            </div>
            {action ? <div className="pt-1">{action}</div> : null}
        </div>
    );
}
