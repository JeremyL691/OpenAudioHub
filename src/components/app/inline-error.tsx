"use client";

import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface InlineErrorProps {
    /** What failed, in plain words. Never a stack trace or a raw server payload. */
    message: string;
    /** Retries the failed operation. The button appears only when this is set. */
    onRetry?: () => void;
    retryLabel?: string;
    className?: string;
}

/** An error shown where the content failed to load, with a retry when one is possible. */
export function InlineError({
    message,
    onRetry,
    retryLabel = "Try again",
    className,
}: InlineErrorProps) {
    return (
        <div
            role="alert"
            className={cn(
                "flex flex-col gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm sm:flex-row sm:items-center sm:justify-between",
                className,
            )}
        >
            <p className="flex items-start gap-2 text-destructive">
                <AlertCircle
                    aria-hidden="true"
                    className="mt-0.5 size-4 shrink-0"
                />
                <span>{message}</span>
            </p>
            {onRetry ? (
                <Button variant="outline" size="sm" onClick={onRetry}>
                    {retryLabel}
                </Button>
            ) : null}
        </div>
    );
}
