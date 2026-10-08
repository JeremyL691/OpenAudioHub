import type { LucideIcon } from "lucide-react";
import {
    AudioLines,
    Bot,
    FileText,
    Play,
    RefreshCw,
    RotateCcw,
} from "lucide-react";
import Link from "next/link";
import { Github } from "@/components/icons/icons";
import { Logo, LogoStacked } from "@/components/icons/logo";
import { Button } from "@/components/ui/button";
import { BRAND } from "@/lib/brand";

interface Feature {
    icon: LucideIcon;
    title: string;
    body: string;
}

const FEATURES: Feature[] = [
    {
        icon: RefreshCw,
        title: "Plaud sync",
        body: "Imports new recordings from your Plaud account, on a schedule or on demand.",
    },
    {
        icon: AudioLines,
        title: "Long-audio chunking",
        body: "Voice activity detection splits multi-hour recordings at natural pauses, so each piece transcribes cleanly.",
    },
    {
        icon: RotateCcw,
        title: "Resumable jobs",
        body: "Each job keeps its progress. If a run stops, it picks up from the last finished chunk instead of starting over.",
    },
    {
        icon: Bot,
        title: "Your speech-to-text provider",
        body: "Point OpenAudioHub at any OpenAI-compatible transcription endpoint, including a model you host yourself.",
    },
    {
        icon: Play,
        title: "Timeline playback",
        body: "Read the transcript next to the audio. Select a line to seek, and the active segment follows playback.",
    },
    {
        icon: FileText,
        title: "Summaries, exports, and automation",
        body: "Generate AI summaries, export transcripts, and connect webhooks and an API to the tools you already use.",
    },
];

interface LandingPageProps {
    /** False when the server runs with `DISABLE_REGISTRATION`; hides every Register action. */
    registrationEnabled: boolean;
}

/**
 * Public front page for signed-out visitors. Server-rendered: it has no client
 * state, so it stays light and the first paint already has the copy.
 */
export function LandingPage({ registrationEnabled }: LandingPageProps) {
    const year = new Date().getFullYear();

    return (
        <div className="flex min-h-svh flex-col bg-background text-foreground">
            <header className="border-b">
                <div className="container mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
                    <Link href="/" aria-label="OpenAudioHub home">
                        <Logo className="text-base" />
                    </Link>
                    <nav
                        aria-label="Primary"
                        className="flex items-center gap-1"
                    >
                        <Button asChild variant="ghost" size="sm">
                            <Link href={BRAND.docsPath}>Docs</Link>
                        </Button>
                        <Button asChild variant="ghost" size="sm">
                            <Link
                                href={BRAND.repoUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                aria-label="View source code on GitHub"
                            >
                                <Github className="size-4" aria-hidden="true" />
                            </Link>
                        </Button>
                        <Button asChild size="sm">
                            <Link href="/login">Sign in</Link>
                        </Button>
                    </nav>
                </div>
            </header>

            <main className="flex-1">
                <section className="container mx-auto flex max-w-6xl flex-col items-center gap-6 px-4 pb-16 pt-16 text-center sm:pt-24">
                    <LogoStacked className="text-xl" />
                    <h1 className="max-w-2xl text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
                        {BRAND.slogan}
                    </h1>
                    <p className="max-w-xl text-pretty text-muted-foreground">
                        {BRAND.description}
                    </p>
                    <div className="flex flex-wrap justify-center gap-3">
                        <Button asChild size="lg">
                            <Link href="/login">Sign in</Link>
                        </Button>
                        {registrationEnabled && (
                            <Button asChild size="lg" variant="outline">
                                <Link href="/register">Create account</Link>
                            </Button>
                        )}
                    </div>
                </section>

                <section
                    aria-labelledby="features-heading"
                    className="container mx-auto max-w-6xl px-4 pb-16"
                >
                    <h2
                        id="features-heading"
                        className="mb-6 text-lg font-semibold"
                    >
                        What it does
                    </h2>
                    <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        {FEATURES.map((feature) => (
                            <li
                                key={feature.title}
                                className="flex flex-col gap-3 rounded-xl border bg-card p-5 text-card-foreground"
                            >
                                <feature.icon
                                    className="size-5 text-primary"
                                    aria-hidden="true"
                                />
                                <h3 className="text-base font-semibold leading-snug">
                                    {feature.title}
                                </h3>
                                <p className="text-sm text-muted-foreground">
                                    {feature.body}
                                </p>
                            </li>
                        ))}
                    </ul>
                </section>

                <section
                    aria-labelledby="self-host-heading"
                    className="container mx-auto max-w-6xl px-4 pb-20"
                >
                    <div className="flex flex-col items-center gap-4 rounded-xl border bg-card p-6 text-center sm:p-10">
                        <h2
                            id="self-host-heading"
                            className="text-xl font-semibold"
                        >
                            Run it on your own server
                        </h2>
                        <p className="max-w-xl text-muted-foreground">
                            Your recordings, transcripts, and API keys stay on
                            infrastructure you control. The code is licensed
                            under AGPL-3.0.
                        </p>
                        <div className="mt-2 flex flex-wrap justify-center gap-3">
                            <Button asChild variant="outline">
                                <Link
                                    href={BRAND.repoUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                >
                                    <Github
                                        className="mr-2 size-4"
                                        aria-hidden="true"
                                    />
                                    View on GitHub
                                </Link>
                            </Button>
                            <Button asChild variant="outline">
                                <Link href={BRAND.docsPath}>Read the docs</Link>
                            </Button>
                        </div>
                    </div>
                </section>
            </main>

            <footer className="border-t">
                <div className="container mx-auto flex max-w-6xl flex-col gap-2 px-4 py-6 font-mono text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
                    <p>
                        © {year} {BRAND.copyrightHolder} · {BRAND.attribution}
                    </p>
                    <p>
                        <Link
                            href={BRAND.repoUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="transition-colors hover:text-foreground"
                        >
                            Source
                        </Link>
                        {" · "}
                        <Link
                            href={BRAND.docsPath}
                            className="transition-colors hover:text-foreground"
                        >
                            Docs
                        </Link>
                    </p>
                </div>
            </footer>
        </div>
    );
}
