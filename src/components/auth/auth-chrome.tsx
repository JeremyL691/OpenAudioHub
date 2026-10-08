import { Check } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Logo, LogoMark } from "@/components/icons/logo";
import { Card } from "@/components/ui/card";
import { BRAND } from "@/lib/brand";

interface AuthChromeProps {
    /** Headline above the form. e.g. "Sign in" / "Create account". */
    title: string;
    /** Optional sub-headline. e.g. "Sign in to your OpenAudioHub instance." */
    subtitle?: string;
    /** The form body (fields + submit + internal nav links). */
    children: ReactNode;
}

/**
 * Brand-panel points. Product facts only: nothing here reads from the instance,
 * its configuration, or the database (see the pre-auth rules below).
 */
const POINTS = [
    "Transcribes your Plaud recordings on infrastructure you control.",
    "Long recordings are split at natural pauses and resume after an interruption.",
    "Open source under AGPL-3.0. Read the code or contribute on GitHub.",
];

// SelfHostAuthChrome
// ---------------------------------------------------------------------------
// The one chrome for every sign-in, sign-up, and password page. From lg up it
// is two columns: a brand panel on the left, the form card on the right. Below
// lg it is a single column with the logo above the card.
//
// The audience here is the operator (and maybe 1-2 invitees) of an instance they
// deployed themselves. They already know what OpenAudioHub is, so the panel is
// short.
//
// Surfaces ONLY non-sensitive context:
//   - Brand copy and the Docs / GitHub links
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
        <div className="grid min-h-svh lg:grid-cols-2">
            <BrandPanel />
            <div className="flex flex-col items-center justify-center gap-6 px-4 py-12 sm:px-8">
                <Link href="/" aria-label="OpenAudioHub" className="lg:hidden">
                    <Logo className="text-xl text-foreground" />
                </Link>
                <div className="w-full max-w-md space-y-6">
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
        </div>
    );
}

function BrandPanel() {
    return (
        <aside
            aria-label="About OpenAudioHub"
            className="hidden flex-col justify-between border-r bg-muted/40 p-10 lg:flex xl:p-14"
        >
            <Link href="/" aria-label="OpenAudioHub home" className="w-fit">
                <Logo className="text-base text-foreground" />
            </Link>
            <div className="max-w-md space-y-6">
                <LogoMark className="size-14" />
                <p className="text-2xl font-semibold leading-snug tracking-tight">
                    {BRAND.slogan}
                </p>
                <ul className="space-y-3 text-sm text-muted-foreground">
                    {POINTS.map((point) => (
                        <li key={point} className="flex gap-3">
                            <Check
                                className="mt-0.5 size-4 shrink-0 text-primary"
                                aria-hidden="true"
                            />
                            <span>{point}</span>
                        </li>
                    ))}
                </ul>
            </div>
            <p className="font-mono text-xs text-muted-foreground">
                {BRAND.copyright}
            </p>
        </aside>
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
