import { usePublicConfig } from "@/lib/public-config";
import { AudioLines, Bot, FileText, Play, RefreshCw, RotateCcw, type LucideIcon } from "lucide-react";
import { Link, Navigate } from "react-router";
import { Button } from "@/components/ui/button";
import { isDesktopApp } from "@/pages/settings/nav";
import { useSession } from "@/lib/session";
import { Brand, CURRENT_YEAR, FooterLink, GitHubIcon, LICENSE_URL, REPO_URL, useDocumentMeta } from "./brand";

const DESCRIPTION =
    "Open-source, self-hosted AI audio workspace for long recordings. Sync your Plaud recordings or upload your own, transcribe with the AI provider you choose, and keep everything on storage you control.";

const FEATURES: { icon: LucideIcon; title: string; text: string }[] = [
    {
        icon: RefreshCw,
        title: "Plaud sync",
        text: "Imports new recordings from your Plaud account, on a schedule or on demand.",
    },
    {
        icon: AudioLines,
        title: "Long-audio chunking",
        text: "Voice activity detection splits multi-hour recordings at natural pauses, so each piece transcribes cleanly.",
    },
    {
        icon: RotateCcw,
        title: "Resumable jobs",
        text: "Each job keeps its progress. If a run stops, it picks up from the last finished chunk instead of starting over.",
    },
    {
        icon: Bot,
        title: "Your speech-to-text provider",
        text: "Point OpenAudioHub at any OpenAI-compatible transcription endpoint, including a model you host yourself.",
    },
    {
        icon: Play,
        title: "Timeline playback",
        text: "Read the transcript next to the audio. Select a line to seek, and the active segment follows playback.",
    },
    {
        icon: FileText,
        title: "Summaries, exports, and automation",
        text: "Generate AI summaries, export transcripts, and use the public API to connect the tools you already use.",
    },
];

/** The public home page. Signed-in users and the desktop app go straight to the dashboard. */
export default function Landing() {
    const { status } = useSession();
    const config = usePublicConfig();
    useDocumentMeta("OpenAudioHub — Long recordings, intelligently transcribed", DESCRIPTION);

    if (status === "authenticated" || isDesktopApp()) return <Navigate to="/dashboard" replace />;

    return (
        <div className="flex min-h-svh flex-col bg-background text-foreground">
            <header className="border-b">
                <div className="container mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
                    <Link to="/" aria-label="OpenAudioHub home" className="text-base">
                        <Brand />
                    </Link>
                    <nav aria-label="Primary" className="flex items-center gap-0.5 sm:gap-1">
                        <Button asChild variant="ghost" className="h-10 px-3 sm:h-8">
                            <Link to="/docs">Docs</Link>
                        </Button>
                        <Button asChild variant="ghost" size="icon" className="size-10 sm:size-8">
                            <a href={REPO_URL} target="_blank" rel="noopener noreferrer" aria-label="View source code on GitHub">
                                <GitHubIcon />
                            </a>
                        </Button>
                        <Button asChild variant="primary" className="h-10 px-3 sm:h-8">
                            <Link to="/login">Sign in</Link>
                        </Button>
                    </nav>
                </div>
            </header>

            <main className="flex-1">
                <section className="container mx-auto flex max-w-6xl flex-col items-center gap-6 px-4 pb-16 pt-16 text-center sm:pt-24">
                    <Brand className="flex-col gap-[0.5em] text-xl" markClassName="size-[3em]" />
                    <h1 className="max-w-2xl text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
                        Long recordings, intelligently transcribed.
                    </h1>
                    <p className="max-w-xl text-pretty text-muted-foreground">
                        Open-source, self-hosted AI audio workspace for long recordings.
                    </p>
                    <div className="flex flex-wrap justify-center gap-3">
                        <Button asChild variant="primary" className="h-10 px-6">
                            <Link to="/login">Sign in</Link>
                        </Button>
                        {config?.registrationEnabled !== false && (
                            <Button
                                asChild
                                variant="secondary"
                                className="h-10 border border-border bg-background px-6 shadow-none hover:bg-accent dark:bg-muted dark:hover:bg-accent"
                            >
                                <Link to="/register">Create account</Link>
                            </Button>
                        )}
                    </div>
                </section>

                <section aria-labelledby="features-heading" className="container mx-auto max-w-6xl px-4 pb-16">
                    <h2 id="features-heading" className="mb-6 text-lg font-semibold">
                        What it does
                    </h2>
                    <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        {FEATURES.map(({ icon: Icon, title, text }) => (
                            <li key={title} className="flex flex-col gap-3 rounded-xl border bg-card p-5 text-card-foreground">
                                <Icon className="size-5 text-primary" aria-hidden="true" />
                                <h3 className="text-base font-semibold leading-snug">{title}</h3>
                                <p className="text-sm text-muted-foreground">{text}</p>
                            </li>
                        ))}
                    </ul>
                </section>

                <section aria-labelledby="self-host-heading" className="container mx-auto max-w-6xl px-4 pb-20">
                    <div className="flex flex-col items-center gap-4 rounded-xl border bg-card p-6 text-center sm:p-10">
                        <h2 id="self-host-heading" className="text-xl font-semibold">
                            Run it on your own server
                        </h2>
                        <p className="max-w-xl text-muted-foreground">
                            Your recordings and transcripts stay on infrastructure you control. The code is licensed
                            under AGPL-3.0.
                        </p>
                        <div className="mt-2 flex flex-wrap justify-center gap-3">
                            <Button asChild variant="secondary" className="h-10 border border-border bg-background px-4 shadow-none hover:bg-accent dark:bg-muted dark:hover:bg-accent sm:h-9">
                                <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
                                    <GitHubIcon className="mr-2" />
                                    View on GitHub
                                </a>
                            </Button>
                            <Button asChild variant="secondary" className="h-10 border border-border bg-background px-4 shadow-none hover:bg-accent dark:bg-muted dark:hover:bg-accent sm:h-9">
                                <Link to="/docs">Read the docs</Link>
                            </Button>
                        </div>
                    </div>
                </section>
            </main>

            <footer className="border-t">
                <div className="container mx-auto flex max-w-6xl flex-col gap-2 px-4 py-6 font-mono text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
                    <p>
                        © {CURRENT_YEAR} OpenAudioHub contributors · Licensed under{" "}
                        <FooterLink href={LICENSE_URL}>AGPL-3.0</FooterLink>
                    </p>
                    <p>
                        <FooterLink href={REPO_URL}>Source</FooterLink> · <FooterLink to="/docs">Docs</FooterLink>
                    </p>
                </div>
            </footer>
        </div>
    );
}
