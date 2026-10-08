"use client";

import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * App Router error boundary. Catches render errors below the root layout and
 * offers a retry. It shows plain language only: never the error message, the
 * stack, or a server response, which can carry internals.
 */
export default function ErrorBoundary({ reset }: { reset: () => void }) {
    return (
        <main className="flex min-h-[60vh] items-center justify-center px-4 py-16">
            <div
                role="alert"
                className="flex w-full max-w-md flex-col items-center gap-3 rounded-lg border border-dashed px-6 py-10 text-center"
            >
                <span className="flex size-10 items-center justify-center rounded-full bg-destructive/10 text-destructive">
                    <AlertCircle aria-hidden="true" className="size-5" />
                </span>
                <div className="max-w-sm space-y-1">
                    <h1 className="text-base font-semibold">
                        Something went wrong
                    </h1>
                    <p className="text-sm text-muted-foreground">
                        Try again. If the problem continues, reload the page.
                    </p>
                </div>
                <div className="pt-1">
                    <Button onClick={() => reset()}>Try again</Button>
                </div>
            </div>
        </main>
    );
}
