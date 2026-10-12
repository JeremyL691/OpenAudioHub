import { FileQuestion } from "lucide-react";
import Link from "next/link";
import { DesktopTitlebar } from "@/components/app-shell/desktop-titlebar";
import { Button } from "@/components/ui/button";
import { getSession } from "@/lib/auth-server";

/**
 * Shown for unknown URLs and for `notFound()` calls. Mirrors the EmptyState look
 * (dashed panel, icon, one next step). It uses an h1 because the page is only this.
 */
export default async function NotFound() {
    const session = await getSession();
    const signedIn = Boolean(session?.user);

    return (
        <main className="flex min-h-svh flex-col bg-background text-foreground">
            <DesktopTitlebar />
            <div className="flex flex-1 items-center justify-center px-4 py-16">
                <div className="flex w-full max-w-md flex-col items-center gap-3 text-center">
                    <span className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                        <FileQuestion aria-hidden="true" className="size-6" />
                    </span>
                    <p className="font-mono text-xs text-muted-foreground">
                        404
                    </p>
                    <div className="max-w-sm space-y-1.5">
                        <h1 className="text-[22px] font-bold tracking-tight">
                            Page not found
                        </h1>
                        <p className="text-[13px] text-muted-foreground">
                            The link may be out of date, or the page may have
                            moved.
                        </p>
                    </div>
                    <div className="pt-2">
                        <Button
                            asChild
                            className="h-10 px-4 text-[13px] sm:h-8"
                        >
                            <Link href={signedIn ? "/recordings" : "/"}>
                                {signedIn ? "Go to recordings" : "Back to home"}
                            </Link>
                        </Button>
                    </div>
                </div>
            </div>
        </main>
    );
}
