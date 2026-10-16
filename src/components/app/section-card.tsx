import type { ReactNode } from "react";
import {
    Card,
    CardAction,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

export interface SectionCardProps {
    /** The section title. Rendered as a heading at the level the caller places it. */
    title: string;
    description?: ReactNode;
    actions?: ReactNode;
    children: ReactNode;
    className?: string;
}

/**
 * A titled group of settings or content, in the grouped-list style: a small
 * muted label sits above a rounded, tinted group holding the children.
 * Replaces the older settings card.
 */
export function SectionCard({
    title,
    description,
    actions,
    children,
    className,
}: SectionCardProps) {
    return (
        <Card
            className={cn(
                "gap-1.5 overflow-visible rounded-none border-0 bg-transparent py-0 shadow-none",
                className,
            )}
        >
            <CardHeader className="px-1">
                <CardTitle className="text-[13px] font-semibold">
                    {title}
                </CardTitle>
                {description ? (
                    <CardDescription className="mt-0.5 text-xs">
                        {description}
                    </CardDescription>
                ) : null}
                {actions ? <CardAction>{actions}</CardAction> : null}
            </CardHeader>
            <CardContent className="rounded-xl bg-muted px-4">
                <div className="divide-y divide-border">{children}</div>
            </CardContent>
        </Card>
    );
}
