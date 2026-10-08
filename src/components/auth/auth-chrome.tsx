import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "@/components/icons/logo";
import { Card } from "@/components/ui/card";

interface AuthChromeProps {
    /** Headline above the form. e.g. "Sign in" / "Create account". */
    title: string;
    /** Optional sub-headline. e.g. "Welcome back to OpenAudioHub." */
    subtitle?: string;
    /** The form body (fields + submit + internal nav links). */
    children: ReactNode;
}

// ---------------------------------------------------------------------------
// SelfHostAuthChrome
// ---------------------------------------------------------------------------
// The audience here is the operator (and maybe 1-2 invitees) of an instance they deployed
// themselves. They already know what OpenAudioHub is -- marketing copy is
// wasted space.
//
// Surfaces ONLY non-sensitive context below the card:
//   - Docs / GitHub links
//
// Explicitly NOT surfaced on this PRE-AUTH page (would leak to anyone
// scanning the internet for vulnerable instances):
//   - App version (helps attackers target known-CVE versions)
//   - APP_URL / hostname / region
//   - User count or other instance metrics
//   - SMTP / storage / AI provider state
//   - Anything sourced from the database
//
// Operational status (version, freshness, health) belongs on the
// post-auth admin dashboard, not here.
export function SelfHostAuthChrome({
    title,
    subtitle,
    children,
}: AuthChromeProps) {
    return (
        <div className="relative flex min-h-screen items-center justify-center px-4 py-12">
            <div className="relative z-10 w-full max-w-md space-y-6">
                <div className="flex justify-center">
                    <Link href="/" aria-label="OpenAudioHub">
                        <Logo className="text-xl text-foreground" />
                    </Link>
                </div>
                <Card className="space-y-6">
                    <div className="space-y-1.5">
                        <h1 className="text-xl font-semibold tracking-tight">
                            {title}
                        </h1>
                        {subtitle ? (
                            <p className="text-sm text-muted-foreground">
                                {subtitle}
                            </p>
                        ) : null}
                    </div>
                    {children}
                </Card>
                <InstanceFooter />
            </div>
        </div>
    );
}

function InstanceFooter() {
    return (
        <div className="flex justify-center text-xs text-muted-foreground font-mono">
            <div className="flex items-center gap-4">
                <Link
                    href="/docs"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-foreground"
                >
                    Docs
                </Link>
                <span aria-hidden className="text-muted-foreground/40">
                    ·
                </span>
                <Link
                    href="https://github.com/JeremyL691/OpenAudioHub"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-foreground"
                >
                    GitHub
                </Link>
            </div>
        </div>
    );
}
