import Link from "next/link";
import { Suspense } from "react";
import { Github } from "@/components/icons/icons";
import { LogoMark } from "@/components/icons/logo";
import { ReportBugButton } from "@/components/report-bug-dialog";
import { UpdateBadge } from "@/components/update-badge";
import { BRAND } from "@/lib/brand";
import { APP_RELEASE_URL, APP_VERSION_TAG } from "@/lib/version";

/**
 * In-app footer rendered on every signed-in screen via
 * `src/app/(app)/layout.tsx`, and on `/install`. Kept deliberately minimal --
 * this is chrome that ships under every workstation, dashboard, and settings
 * pane, so weight here is paid for on every view.
 *
 * Server component so it can render the server-only `UpdateBadge` directly.
 */
export function Footer() {
    const currentYear = new Date().getFullYear();

    return (
        <footer className="border-t border-border/40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
            <div className="container mx-auto px-4 py-3 max-w-7xl">
                <div className="flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-muted-foreground font-mono">
                    <div className="flex items-center gap-2">
                        <LogoMark className="size-4" />
                        <span>
                            © {currentYear} {BRAND.copyrightHolder} · Licensed
                            under{" "}
                            <Link
                                href="https://www.gnu.org/licenses/agpl-3.0.html"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="hover:text-foreground transition-colors underline decoration-dotted underline-offset-2"
                            >
                                AGPL-3.0
                            </Link>
                            {" · "}
                            <Link
                                href={BRAND.noticeUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="hover:text-foreground transition-colors underline decoration-dotted underline-offset-2"
                            >
                                Notices
                            </Link>
                        </span>
                    </div>

                    <div className="flex items-center gap-3">
                        {/* Update notice. Suspended with a null fallback so a
                            cold GitHub-API cache doesn't block the rest of the
                            footer from streaming. */}
                        <Suspense fallback={null}>
                            <UpdateBadge />
                        </Suspense>
                        <Link
                            href={APP_RELEASE_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:text-foreground transition-colors"
                            aria-label={`Release notes for OpenAudioHub ${APP_VERSION_TAG}`}
                        >
                            {APP_VERSION_TAG}
                        </Link>
                        <Link
                            href="/docs"
                            className="hover:text-foreground transition-colors"
                        >
                            Docs
                        </Link>
                        <ReportBugButton className="hover:text-foreground transition-colors" />
                        <Link
                            href="https://github.com/JeremyL691/OpenAudioHub"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:text-foreground transition-colors"
                            aria-label="View source code on GitHub"
                        >
                            <Github className="size-4" />
                        </Link>
                    </div>
                </div>
            </div>
        </footer>
    );
}
