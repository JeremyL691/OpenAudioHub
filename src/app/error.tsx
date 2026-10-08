"use client";

import { Button } from "@/components/ui/button";

/**
 * App Router error boundary. Catches render errors thrown below the root
 * layout and offers a retry.
 */
export default function ErrorBoundary({ reset }: { reset: () => void }) {
    return (
        <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-4 text-center">
            <h2 className="text-lg font-medium">Something went wrong</h2>
            <p className="text-sm text-muted-foreground">
                Try again, or reload the page if it keeps happening.
            </p>
            <Button onClick={() => reset()}>Try again</Button>
        </div>
    );
}
