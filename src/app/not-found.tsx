import { FileQuestion } from "lucide-react";
import Link from "next/link";
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
        <main className="flex min-h-svh items-center justify-center bg-background px-4 py-16">
            <div className="flex w-full max-w-md flex-col items-center gap-3 rounded-lg border border-dashed px-6 py-10 text-center">
                <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
                    <FileQuestion aria-hidden="true" className="size-5" />
                </span>
                <p className="font-mono text-xs text-muted-foreground">404</p>
                <div className="max-w-sm space-y-1">
                    <h1 className="text-base font-semibold">Page not found</h1>
                    <p className="text-sm text-muted-foreground">
                        The link may be out of date, or the page may have moved.
                    </p>
                </div>
                <div className="pt-1">
                    <Button asChild>
                        <Link href={signedIn ? "/recordings" : "/"}>
                            {signedIn ? "Go to recordings" : "Back to home"}
                        </Link>
                    </Button>
                </div>
            </div>
        </main>
    );
}
