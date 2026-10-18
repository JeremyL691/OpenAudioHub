import { useEffect, useState } from "react";
import { Copy } from "lucide-react";
import { Link } from "react-router";
import { api } from "@/lib/api";
import { Brand, CURRENT_YEAR, FooterLink, GitHubIcon, LICENSE_URL, REPO_URL, useDocumentMeta } from "./brand";

const DESCRIPTION =
    "Self-host OpenAudioHub with a single curl command. Docker + Compose v2 required. AGPL-3.0, no telemetry, no license server.";
const LATEST_COMMAND = `curl -fsSL ${REPO_URL}/releases/latest/download/install.sh | sh`;

/** Installer command box: a dark-on-muted terminal strip with a copy button. */
function CommandBox({ command, copyLabel, disabled = false }: { command: string; copyLabel: string; disabled?: boolean }) {
    const [copied, setCopied] = useState(false);

    async function copy() {
        if (disabled) return;
        try {
            await navigator.clipboard.writeText(command);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
        } catch {
            // The clipboard can be blocked. The command stays visible to copy by hand.
        }
    }

    return (
        <div className="overflow-hidden rounded-lg bg-muted font-mono text-[12px]">
            <div className="px-3 pt-2 text-[11px] text-muted-foreground">~/openaudiohub</div>
            <div className="flex items-center gap-3 px-3 py-2">
                <div className="flex-1 overflow-x-auto">
                    <span className="text-muted-foreground">$ </span>
                    <span className="whitespace-nowrap text-foreground">{command}</span>
                </div>
                <button
                    type="button"
                    aria-label={copyLabel}
                    disabled={disabled}
                    onClick={copy}
                    className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50 sm:h-8"
                >
                    <Copy className="size-3.5" aria-hidden="true" />
                    <span>{copied ? "Copied" : "Copy"}</span>
                </button>
            </div>
        </div>
    );
}

/** The install guide at /install. The pinned command uses the version the server reports. */
export default function Install() {
    const [version, setVersion] = useState<string | null>(null);
    useDocumentMeta("Install OpenAudioHub | Self-host in one command · OpenAudioHub", DESCRIPTION);

    useEffect(() => {
        api<{ version?: string }>("/api/health")
            .then((body) => setVersion(body.version ?? null))
            .catch(() => setVersion(null));
    }, []);

    // Until the server reports its version, the pinned command shows a placeholder and its copy button is off.
    const tag = version ? `v${version}` : "";
    const pinnedCommand = `curl -fsSL ${REPO_URL}/releases/download/${tag || "<version>"}/install.sh | sh`;

    return (
        <div className="flex min-h-svh flex-col bg-background text-foreground">
            <header className="border-b border-border bg-background/80 backdrop-blur">
                <div className="container mx-auto flex h-13 max-w-4xl items-center justify-between px-4">
                    <Link to="/" aria-label="OpenAudioHub" className="flex items-center transition-opacity hover:opacity-80">
                        <Brand className="text-xl" />
                    </Link>
                </div>
            </header>

            <main className="flex-1">
                <section className="container mx-auto max-w-4xl px-4 py-16 md:py-20">
                    <div className="max-w-2xl">
                        <div className="mb-6 inline-flex items-center rounded-full bg-muted px-2 py-0.5 font-mono text-[11px] font-medium text-muted-foreground">
                            Self-host
                        </div>
                        <h1 className="mb-6 text-[22px] font-bold tracking-tight">Install OpenAudioHub</h1>
                        <p className="text-[13px] leading-relaxed text-muted-foreground">
                            All you need is a machine with Docker and Compose v2. The installer downloads the release's{" "}
                            <code className="font-mono text-foreground">compose.yml</code>, writes a fresh{" "}
                            <code className="font-mono text-foreground">.env</code> with a newly generated{" "}
                            <code className="font-mono text-foreground">ENCRYPTION_KEY</code> and your{" "}
                            <code className="font-mono text-foreground">APP_URL</code>, starts the stack, and waits for{" "}
                            <code className="font-mono text-foreground">/api/health</code>.
                        </p>
                    </div>

                    <div className="mt-10 space-y-3">
                        <div className="flex items-baseline justify-between gap-4">
                            <h2 className="text-[13px] font-semibold text-muted-foreground">Latest release</h2>
                            <a
                                href="https://github.com/JeremyL691/OpenAudioHub/releases/latest/download/install.sh"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="font-mono text-xs text-link transition-colors hover:opacity-80"
                            >
                                View raw script →
                            </a>
                        </div>
                        <CommandBox command={LATEST_COMMAND} copyLabel="Copy install command" />
                    </div>

                    <div className="mt-8 space-y-3">
                        <h2 className="text-[13px] font-semibold text-muted-foreground">Pin to a specific version</h2>
                        <CommandBox command={pinnedCommand} copyLabel="Copy version-pinned install command" disabled={!tag} />
                        <p className="text-[13px] text-muted-foreground">
                            Replace <code className="font-mono">{tag || "vX.Y.Z"}</code> with any released tag from{" "}
                            <a
                                href={`${REPO_URL}/releases`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-link underline decoration-dotted underline-offset-2 transition-colors hover:opacity-80"
                            >
                                the releases page
                            </a>
                            .
                        </p>
                    </div>

                    <div className="mt-16 grid gap-8 md:grid-cols-2">
                        <div className="space-y-2">
                            <h2 className="text-[13px] font-semibold text-muted-foreground">Requirements</h2>
                            <ul className="list-disc space-y-1.5 pl-5 text-[13px] text-muted-foreground">
                                <li>Linux or macOS</li>
                                <li>Docker (any modern version)</li>
                                <li>Docker Compose v2</li>
                                <li>Outbound HTTPS to GitHub</li>
                            </ul>
                        </div>
                        <div className="space-y-2">
                            <h2 className="text-[13px] font-semibold text-muted-foreground">What the script does</h2>
                            <ul className="list-disc space-y-1.5 pl-5 text-[13px] text-muted-foreground">
                                <li>Verifies Docker + Compose v2</li>
                                <li>
                                    Downloads the current <code className="font-mono text-foreground">compose.yml</code> for the release
                                </li>
                                <li>
                                    Creates a new <code className="font-mono text-foreground">.env</code> with a generated{" "}
                                    <code className="font-mono text-foreground">ENCRYPTION_KEY</code> and your{" "}
                                    <code className="font-mono text-foreground">APP_URL</code>
                                </li>
                                <li>
                                    Starts the stack, waits on <code className="font-mono text-foreground">/api/health</code>
                                </li>
                            </ul>
                        </div>
                    </div>

                    <div className="mt-12 rounded-xl bg-muted/60 p-5">
                        <h2 className="mb-2 text-[13px] font-semibold">Don't want to pipe to shell?</h2>
                        <p className="text-[13px] leading-relaxed text-muted-foreground">
                            Fair. Read the source at{" "}
                            <a
                                href={`${REPO_URL}/blob/main/scripts/install.sh`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-link underline decoration-dotted underline-offset-2 transition-colors hover:opacity-80"
                            >
                                scripts/install.sh
                            </a>{" "}
                            on GitHub, or follow the manual{" "}
                            <a
                                href={`${REPO_URL}#self-host`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-link underline decoration-dotted underline-offset-2 transition-colors hover:opacity-80"
                            >
                                self-host instructions
                            </a>{" "}
                            in the README. The whole project is AGPL-3.0. Have a look at the source before you run it.
                        </p>
                    </div>
                </section>
            </main>

            <footer className="border-t border-border/40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
                <div className="container mx-auto max-w-7xl px-4 py-3">
                    <div className="flex flex-col items-center justify-between gap-2 font-mono text-xs text-muted-foreground sm:flex-row">
                        <div className="flex items-center gap-2">
                            <img src="/icon.svg" alt="" aria-hidden="true" className="size-4 shrink-0" />
                            <span>
                                © {CURRENT_YEAR} OpenAudioHub contributors · Licensed under{" "}
                                <a
                                    href={LICENSE_URL}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="underline decoration-dotted underline-offset-2 transition-colors hover:text-foreground"
                                >
                                    AGPL-3.0
                                </a>{" "}
                                ·{" "}
                                <a
                                    href={`${REPO_URL}/blob/main/NOTICE`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="underline decoration-dotted underline-offset-2 transition-colors hover:text-foreground"
                                >
                                    Notices
                                </a>
                            </span>
                        </div>
                        <div className="flex items-center gap-3">
                            {version && (
                                <a
                                    href={`${REPO_URL}/releases/tag/${tag}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    aria-label={`Release notes for OpenAudioHub ${tag}`}
                                    className="transition-colors hover:text-foreground"
                                >
                                    {tag}
                                </a>
                            )}
                            <FooterLink to="/docs">Docs</FooterLink>
                            <FooterLink href={`${REPO_URL}/issues/new`}>Report a bug</FooterLink>
                            <a
                                href={REPO_URL}
                                target="_blank"
                                rel="noopener noreferrer"
                                aria-label="View source code on GitHub"
                                className="transition-colors hover:text-foreground"
                            >
                                <GitHubIcon />
                            </a>
                        </div>
                    </div>
                </div>
            </footer>
        </div>
    );
}
