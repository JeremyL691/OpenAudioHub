import { FileQuestionMark } from "lucide-react";
import { Link } from "react-router";
import { useSession } from "@/lib/session";
import { Button } from "@/components/ui/button";

export default function Page() {
    const { status } = useSession();
    // While the session loads, show the signed-out wording; it is short enough not to shift the layout much.
    const signedIn = status === "authenticated";

    return (
        <>
            <title>OpenAudioHub — Long recordings, intelligently transcribed</title>
            <meta name="robots" content="noindex" />
            <main className="flex min-h-svh flex-col bg-background text-foreground">
                <div className="flex flex-1 items-center justify-center px-4 py-16">
                    <div className="flex w-full max-w-md flex-col items-center gap-3 text-center">
                        <span className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                            <FileQuestionMark aria-hidden="true" className="size-6" />
                        </span>
                        <p className="font-mono text-xs text-muted-foreground">404</p>
                        <div className="max-w-sm space-y-1.5">
                            <h1 className="text-[22px] font-bold tracking-tight">Page not found</h1>
                            <p className="text-[13px] text-muted-foreground">The link may be out of date, or the page may have moved.</p>
                        </div>
                        <div className="pt-2">
                            <Button asChild variant="primary" className="h-10 px-4 text-[13px] sm:h-8">
                                <Link to={signedIn ? "/recordings" : "/"}>{signedIn ? "Go to recordings" : "Back to home"}</Link>
                            </Button>
                        </div>
                    </div>
                </div>
            </main>
        </>
    );
}
