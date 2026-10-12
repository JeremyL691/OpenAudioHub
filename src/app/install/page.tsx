import type { Metadata } from "next";
import Link from "next/link";
import { DesktopTitlebar } from "@/components/app-shell/desktop-titlebar";
import { CopyableCommand } from "@/components/copyable-command";
import { Footer } from "@/components/footer";
import { Logo } from "@/components/icons/logo";
import { INSTALL_ONELINER, pinnedInstallCommand } from "@/lib/install-commands";
import { APP_VERSION_TAG } from "@/lib/version";

/**
 * Public "how do I self-host this?" page. A friendlier entry point than
 * dumping `/install.sh` straight into the browser.
 *
 * Deliberately a server component -- the only interactive bit is the
 * Copy button inside `<CopyableCommand>` (a small client island).
 * Reads `APP_VERSION_TAG` at build time so the version-pinned form
 * below always matches the running build.
 */

export const metadata: Metadata = {
    title: "Install OpenAudioHub | Self-host in one command",
    description:
        "Self-host OpenAudioHub with a single curl command. Docker + Compose v2 required. AGPL-3.0, no telemetry, no license server.",
};

const ONE_LINER = INSTALL_ONELINER;
const PINNED_LINER = pinnedInstallCommand(APP_VERSION_TAG);

export default function InstallPage() {
    return (
        <div className="flex min-h-svh flex-col bg-background text-foreground">
            <DesktopTitlebar />
            <header className="border-b border-border bg-background/80 backdrop-blur">
                <div className="container mx-auto flex h-13 max-w-4xl items-center justify-between px-4">
                    <Link
                        href="/"
                        className="flex items-center hover:opacity-80 transition-opacity"
                        aria-label="OpenAudioHub"
                    >
                        <Logo className="text-xl" />
                    </Link>
                </div>
            </header>

            <main className="flex-1">
                <section className="container mx-auto max-w-4xl px-4 py-16 md:py-20">
                    <div className="max-w-2xl">
                        <div className="mb-6 inline-flex items-center rounded-full bg-muted px-2 py-0.5 font-mono text-[11px] font-medium text-muted-foreground">
                            Self-host
                        </div>
                        <h1 className="mb-6 text-[22px] font-bold tracking-tight">
                            Install OpenAudioHub
                        </h1>
                        <p className="text-[13px] leading-relaxed text-muted-foreground">
                            One command on a machine with Docker and Compose v2.
                            The installer pulls the latest release&apos;s{" "}
                            <code className="font-mono text-foreground">
                                docker-compose.yml
                            </code>{" "}
                            and{" "}
                            <code className="font-mono text-foreground">
                                env.example
                            </code>
                            , generates secrets, starts the stack, and waits on{" "}
                            <code className="font-mono text-foreground">
                                /api/health
                            </code>
                            .
                        </p>
                    </div>

                    <div className="mt-10 space-y-3">
                        <div className="flex items-baseline justify-between gap-4">
                            <h2 className="text-[13px] font-semibold text-muted-foreground">
                                Latest release
                            </h2>
                            <Link
                                href="/install.sh"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="font-mono text-xs text-link transition-colors hover:opacity-80"
                            >
                                View raw script →
                            </Link>
                        </div>
                        <CopyableCommand
                            command={ONE_LINER}
                            ariaLabel="Copy install command"
                        />
                    </div>

                    <div className="mt-8 space-y-3">
                        <h2 className="text-[13px] font-semibold text-muted-foreground">
                            Pin to a specific version
                        </h2>
                        <CopyableCommand
                            command={PINNED_LINER}
                            ariaLabel="Copy version-pinned install command"
                        />
                        <p className="text-[13px] text-muted-foreground">
                            Replace{" "}
                            <code className="font-mono">{APP_VERSION_TAG}</code>{" "}
                            with any released tag from{" "}
                            <Link
                                href="https://github.com/JeremyL691/OpenAudioHub/releases"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-link underline decoration-dotted underline-offset-2 transition-colors hover:opacity-80"
                            >
                                the releases page
                            </Link>
                            .
                        </p>
                    </div>

                    <div className="mt-16 grid gap-8 md:grid-cols-2">
                        <div className="space-y-2">
                            <h2 className="text-[13px] font-semibold text-muted-foreground">
                                Requirements
                            </h2>
                            <ul className="list-disc space-y-1.5 pl-5 text-[13px] text-muted-foreground">
                                <li>Linux or macOS</li>
                                <li>Docker (any modern version)</li>
                                <li>Docker Compose v2</li>
                                <li>Outbound HTTPS to GitHub</li>
                            </ul>
                        </div>
                        <div className="space-y-2">
                            <h2 className="text-[13px] font-semibold text-muted-foreground">
                                What the script does
                            </h2>
                            <ul className="list-disc space-y-1.5 pl-5 text-[13px] text-muted-foreground">
                                <li>Verifies Docker + Compose v2</li>
                                <li>
                                    Downloads{" "}
                                    <code className="font-mono text-foreground">
                                        docker-compose.yml
                                    </code>{" "}
                                    + env template
                                </li>
                                <li>
                                    Generates{" "}
                                    <code className="font-mono text-foreground">
                                        BETTER_AUTH_SECRET
                                    </code>
                                    ,{" "}
                                    <code className="font-mono text-foreground">
                                        ENCRYPTION_KEY
                                    </code>
                                    ,{" "}
                                    <code className="font-mono text-foreground">
                                        POSTGRES_PASSWORD
                                    </code>
                                </li>
                                <li>
                                    Starts the stack, waits on{" "}
                                    <code className="font-mono text-foreground">
                                        /api/health
                                    </code>
                                </li>
                            </ul>
                        </div>
                    </div>

                    <div className="mt-12 rounded-xl bg-muted/60 p-5">
                        <h2 className="mb-2 text-[13px] font-semibold">
                            Don&apos;t want to pipe to shell?
                        </h2>
                        <p className="text-[13px] leading-relaxed text-muted-foreground">
                            Fair. Read the source at{" "}
                            <Link
                                href="https://github.com/JeremyL691/OpenAudioHub/blob/main/scripts/install.sh"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-link underline decoration-dotted underline-offset-2 transition-colors hover:opacity-80"
                            >
                                scripts/install.sh
                            </Link>{" "}
                            on GitHub, or follow the manual{" "}
                            <Link
                                href="https://github.com/JeremyL691/OpenAudioHub#self-host"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-link underline decoration-dotted underline-offset-2 transition-colors hover:opacity-80"
                            >
                                self-host instructions
                            </Link>{" "}
                            in the README. The whole project is AGPL-3.0,
                            inspect everything before you run it.
                        </p>
                    </div>
                </section>
            </main>

            <Footer />
        </div>
    );
}
