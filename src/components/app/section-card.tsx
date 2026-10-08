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

/** A titled group of settings or content. Replaces the older settings card. */
export function SectionCard({
    title,
    description,
    actions,
    children,
    className,
}: SectionCardProps) {
    return (
        <Card className={cn("gap-4", className)}>
            <CardHeader>
                <CardTitle className="text-base font-semibold">
                    {title}
                </CardTitle>
                {description ? (
                    <CardDescription>{description}</CardDescription>
                ) : null}
                {actions ? <CardAction>{actions}</CardAction> : null}
            </CardHeader>
            <CardContent>{children}</CardContent>
        </Card>
    );
}
