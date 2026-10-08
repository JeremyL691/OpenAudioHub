import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface PageHeaderProps {
    /** The page title. Rendered as the page's only h1. */
    title: string;
    description?: ReactNode;
    /** Buttons or controls aligned to the end of the header. */
    actions?: ReactNode;
    className?: string;
}

/** A page's title, description, and actions. Actions wrap below the title on narrow screens. */
export function PageHeader({
    title,
    description,
    actions,
    className,
}: PageHeaderProps) {
    return (
        <header
            className={cn(
                "flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between",
                className,
            )}
        >
            <div className="min-w-0 space-y-1">
                <h1 className="text-2xl font-semibold tracking-tight">
                    {title}
                </h1>
                {description ? (
                    <p className="text-sm text-muted-foreground">
                        {description}
                    </p>
                ) : null}
            </div>
            {actions ? (
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {actions}
                </div>
            ) : null}
        </header>
    );
}
