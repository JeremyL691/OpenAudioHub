import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface EmptyStateProps {
    icon?: ReactNode;
    title: ReactNode;
    description?: ReactNode;
    /** Buttons or links, shown in a row. */
    action?: ReactNode;
    /** Heading level for the title. Use 2 under the page's h1 and 3 under a section heading. */
    headingLevel?: 2 | 3;
    className?: string;
}

export function EmptyState({ icon, title, description, action, headingLevel = 2, className }: EmptyStateProps) {
    const Heading = headingLevel === 3 ? "h3" : "h2";
    return (
        <div className={cn("flex flex-col items-center gap-3 px-6 py-12 text-center", className)}>
            {icon ? <div className="text-muted-foreground [&_svg]:size-10" aria-hidden="true">{icon}</div> : null}
            <Heading className="text-[17px] font-semibold tracking-tight text-foreground">{title}</Heading>
            {description ? <p className="max-w-sm text-sm text-muted-foreground">{description}</p> : null}
            {action ? <div className="mt-2 flex flex-wrap items-center justify-center gap-2">{action}</div> : null}
        </div>
    );
}
