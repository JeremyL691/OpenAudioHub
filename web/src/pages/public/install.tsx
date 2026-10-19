import { useEffect, useState } from "react";
import { Copy } from "lucide-react";
import { Link } from "react-router";
import { api } from "@/lib/api";
import { Brand, CURRENT_YEAR, FooterLink, GitHubIcon, LICENSE_URL, REPO_URL, useDocumentMeta } from "./brand";
import { useI18n } from "@/lib/i18n";
import { LanguagePicker } from "@/components/shell/language-picker";

const LATEST_COMMAND = `curl -fsSL ${REPO_URL}/releases/latest/download/install.sh | sh`;

/** Installer command box: a dark-on-muted terminal strip with a copy button. */
function CommandBox({ command, copyLabel, disabled = false }: { command: string; copyLabel: string; disabled?: boolean }) {
    const { t } = useI18n();
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
                    <span>{copied ? t("public.install.copied") : t("public.install.copy")}</span>
                </button>
            </div>
        </div>
    );
}

/** The install guide at /install. The pinned command uses the version the server reports. */
export default function Install() {
    const { t } = useI18n();
    const [version, setVersion] = useState<string | null>(null);
    useDocumentMeta(t("public.install.documentTitle"), t("public.install.description"));

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
                    <Link to="/" aria-label={t("public.landing.home")} className="flex items-center transition-opacity hover:opacity-80">
                        <Brand className="text-xl" />
                    </Link>
                    <LanguagePicker />
                </div>
            </header>

            <main className="flex-1">
                <section className="container mx-auto max-w-4xl px-4 py-16 md:py-20">
                    <div className="max-w-2xl">
                        <div className="mb-6 inline-flex items-center rounded-full bg-muted px-2 py-0.5 font-mono text-[11px] font-medium text-muted-foreground">
                            {t("public.install.badge")}
                        </div>
                        <h1 className="mb-6 text-[22px] font-bold tracking-tight">{t("public.install.title")}</h1>
                        <p className="text-[13px] leading-relaxed text-muted-foreground">{t("public.install.intro")}</p>
                    </div>

                    <div className="mt-10 space-y-3">
                        <div className="flex items-baseline justify-between gap-4">
                            <h2 className="text-[13px] font-semibold text-muted-foreground">{t("public.install.latestRelease")}</h2>
                            <a
                                href="https://github.com/JeremyL691/OpenAudioHub/releases/latest/download/install.sh"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="font-mono text-xs text-link transition-colors hover:opacity-80"
                            >
                                {t("public.install.viewRaw")}
                            </a>
                        </div>
                        <CommandBox command={LATEST_COMMAND} copyLabel={t("public.install.copyInstallCommand")} />
                    </div>

                    <div className="mt-8 space-y-3">
                        <h2 className="text-[13px] font-semibold text-muted-foreground">{t("public.install.pinTitle")}</h2>
                        <CommandBox command={pinnedCommand} copyLabel={t("public.install.copyPinnedCommand")} disabled={!tag} />
                        <p className="text-[13px] text-muted-foreground">{t("public.install.pinHint", { tag: tag || "vX.Y.Z" })}</p>
                    </div>

                    <div className="mt-16 grid gap-8 md:grid-cols-2">
                        <div className="space-y-2">
                            <h2 className="text-[13px] font-semibold text-muted-foreground">{t("public.install.requirements")}</h2>
                            <ul className="list-disc space-y-1.5 pl-5 text-[13px] text-muted-foreground">
                                {t("public.install.requirementsList").split("\n").map((line) => (
                                    <li key={line}>{line}</li>
                                ))}
                            </ul>
                        </div>
                        <div className="space-y-2">
                            <h2 className="text-[13px] font-semibold text-muted-foreground">{t("public.install.whatItDoes")}</h2>
                            <ul className="list-disc space-y-1.5 pl-5 text-[13px] text-muted-foreground">
                                {t("public.install.whatItDoesList").split("\n").map((line) => (
                                    <li key={line}>{line}</li>
                                ))}
                            </ul>
                        </div>
                    </div>

                    <div className="mt-12 rounded-xl bg-muted/60 p-5">
                        <h2 className="mb-2 text-[13px] font-semibold">{t("public.install.noPipeTitle")}</h2>
                        <p className="text-[13px] leading-relaxed text-muted-foreground">{t("public.install.noPipeBody")}</p>
                    </div>
                </section>
            </main>

            <footer className="border-t border-border/40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
                <div className="container mx-auto max-w-7xl px-4 py-3">
                    <div className="flex flex-col items-center justify-between gap-2 font-mono text-xs text-muted-foreground sm:flex-row">
                        <div className="flex items-center gap-2">
                            <img src="/icon.svg" alt="" aria-hidden="true" className="size-4 shrink-0" />
                            <span>
                                {t("public.footer.copyright", { year: CURRENT_YEAR })} · {t("public.footer.license")}{" "}
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
                                    {t("public.footer.notices")}
                                </a>
                            </span>
                        </div>
                        <div className="flex items-center gap-3">
                            {version && (
                                <a
                                    href={`${REPO_URL}/releases/tag/${tag}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    aria-label={t("public.install.releaseNotes", { tag })}
                                    className="transition-colors hover:text-foreground"
                                >
                                    {tag}
                                </a>
                            )}
                            <FooterLink to="/docs">{t("public.footer.docs")}</FooterLink>
                            <FooterLink href={`${REPO_URL}/issues/new`}>{t("public.footer.reportBug")}</FooterLink>
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
