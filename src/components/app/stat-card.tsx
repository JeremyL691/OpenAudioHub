import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export interface StatCardProps {
    label: string;
    value: ReactNode;
    /** A short note under the value, such as the period it covers. */
    hint?: ReactNode;
    icon?: LucideIcon;
    className?: string;
}

/** One figure with its label. The value uses tabular figures so numbers line up across cards. */
export function StatCard({
    label,
    value,
    hint,
    icon: Icon,
    className,
}: StatCardProps) {
    return (
        <Card className={cn("gap-2 py-4", className)}>
            <CardContent className="space-y-1">
                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span>{label}</span>
                    {Icon ? (
                        <Icon aria-hidden="true" className="size-4" />
                    ) : null}
                </div>
                <p className="text-2xl font-semibold tabular-nums tracking-tight">
                    {value}
                </p>
                {hint ? (
                    <p className="text-xs text-muted-foreground">{hint}</p>
                ) : null}
            </CardContent>
        </Card>
    );
}
