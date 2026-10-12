"use client";

import { AlertCircle } from "lucide-react";
import { DesktopTitlebar } from "@/components/app-shell/desktop-titlebar";
import { Button } from "@/components/ui/button";

/**
 * App Router error boundary. Catches render errors below the root layout and
 * offers a retry. It shows plain language only: never the error message, the
 * stack, or a server response, which can carry internals.
 */
export default function ErrorBoundary({ reset }: { reset: () => void }) {
    return (
        <main className="flex min-h-svh flex-col bg-background text-foreground">
            <DesktopTitlebar />
            <div className="flex flex-1 items-center justify-center px-4 py-16">
                <div
                    role="alert"
                    className="flex w-full max-w-md flex-col items-center gap-3 text-center"
                >
                    <span className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                        <AlertCircle aria-hidden="true" className="size-6" />
                    </span>
                    <div className="max-w-sm space-y-1.5">
                        <h1 className="text-[22px] font-bold tracking-tight">
                            Something went wrong
                        </h1>
                        <p className="text-[13px] text-muted-foreground">
                            Try again. If the problem continues, reload the
                            page.
                        </p>
                    </div>
                    <div className="pt-2">
                        <Button
                            className="h-10 px-4 text-[13px] sm:h-8"
                            onClick={() => reset()}
                        >
                            Try again
                        </Button>
                    </div>
                </div>
            </div>
        </main>
    );
}
