import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface StatCardProps {
    label: string;
    value: ReactNode;
    /** A short note under the value, such as the period it covers. */
    hint?: ReactNode;
    icon?: LucideIcon;
    className?: string;
}

/** One figure with its label. The value uses tabular figures so numbers line up across cells. */
export function StatCard({
    label,
    value,
    hint,
    icon: Icon,
    className,
}: StatCardProps) {
    return (
        <div className={cn("rounded-2xl bg-card p-4 shadow-card", className)}>
            <div className="flex items-center justify-between gap-2 text-[13px] text-muted-foreground">
                <span>{label}</span>
                {Icon ? (
                    <Icon
                        aria-hidden="true"
                        className="size-3.5 text-muted-foreground/70"
                    />
                ) : null}
            </div>
            <p className="mt-1 flex flex-wrap items-baseline gap-x-2">
                <span className="text-[28px] font-semibold tracking-tight tabular-nums">
                    {value}
                </span>
                {hint ? (
                    <span className="text-[13px] text-muted-foreground">
                        {hint}
                    </span>
                ) : null}
            </p>
        </div>
    );
}
