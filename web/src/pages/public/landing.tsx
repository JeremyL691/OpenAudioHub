import { usePublicConfig } from "@/lib/public-config";
import { AudioLines, Bot, FileText, Play, RefreshCw, RotateCcw, type LucideIcon } from "lucide-react";
import { Link, Navigate } from "react-router";
import { Button } from "@/components/ui/button";
import { isDesktopApp } from "@/pages/settings/nav";
import { useSession } from "@/lib/session";
import { Brand, CURRENT_YEAR, FooterLink, GitHubIcon, LICENSE_URL, REPO_URL, useDocumentMeta } from "./brand";
import { useI18n } from "@/lib/i18n";
import { LanguagePicker } from "@/components/shell/language-picker";

const FEATURES: { icon: LucideIcon; titleKey: "public.landing.featurePlaudTitle" | "public.landing.featureChunkingTitle" | "public.landing.featureResumeTitle" | "public.landing.featureProviderTitle" | "public.landing.featureTimelineTitle" | "public.landing.featureExportTitle"; textKey: "public.landing.featurePlaudText" | "public.landing.featureChunkingText" | "public.landing.featureResumeText" | "public.landing.featureProviderText" | "public.landing.featureTimelineText" | "public.landing.featureExportText" }[] = [
    {
        icon: RefreshCw,
        titleKey: "public.landing.featurePlaudTitle",
        textKey: "public.landing.featurePlaudText",
    },
    {
        icon: AudioLines,
        titleKey: "public.landing.featureChunkingTitle",
        textKey: "public.landing.featureChunkingText",
    },
    {
        icon: RotateCcw,
        titleKey: "public.landing.featureResumeTitle",
        textKey: "public.landing.featureResumeText",
    },
    {
        icon: Bot,
        titleKey: "public.landing.featureProviderTitle",
        textKey: "public.landing.featureProviderText",
    },
    {
        icon: Play,
        titleKey: "public.landing.featureTimelineTitle",
        textKey: "public.landing.featureTimelineText",
    },
    {
        icon: FileText,
        titleKey: "public.landing.featureExportTitle",
        textKey: "public.landing.featureExportText",
    },
];

/** The public home page. Signed-in users and the desktop app go straight to the dashboard. */
export default function Landing() {
    const { status } = useSession();
    const { t } = useI18n();
    const config = usePublicConfig();
    useDocumentMeta(t("public.landing.documentTitle"), t("public.landing.description"));

    if (status === "authenticated" || isDesktopApp()) return <Navigate to="/dashboard" replace />;

    return (
        <div className="flex min-h-svh flex-col bg-background text-foreground">
            <header className="border-b">
                <div className="container mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
                    <Link to="/" aria-label={t("public.landing.home")} className="text-base">
                        <Brand />
                    </Link>
                    <nav aria-label={t("public.landing.primaryNav")} className="flex items-center gap-0.5 sm:gap-1">
                        <Button asChild variant="ghost" className="h-10 px-3 sm:h-8">
                            <Link to="/docs">{t("public.landing.docs")}</Link>
                        </Button>
                        <Button asChild variant="ghost" size="icon" className="size-10 sm:size-8">
                            <a href={REPO_URL} target="_blank" rel="noopener noreferrer" aria-label={t("public.landing.viewSource")}>
                                <GitHubIcon />
                            </a>
                        </Button>
                        <Button asChild variant="primary" className="h-10 px-3 sm:h-8">
                            <Link to="/login">{t("public.landing.signIn")}</Link>
                        </Button>
                    </nav>
                </div>
            </header>

            <main className="flex-1">
                <section className="container mx-auto flex max-w-6xl flex-col items-center gap-6 px-4 pb-16 pt-16 text-center sm:pt-24">
                    <Brand className="flex-col gap-[0.5em] text-xl" markClassName="size-[3em]" />
                    <h1 className="max-w-2xl text-balance text-3xl font-semibold tracking-tight sm:text-4xl">{t("public.landing.headline")}</h1>
                    <p className="max-w-xl text-pretty text-muted-foreground">{t("public.landing.subhead")}</p>
                    <div className="flex flex-wrap justify-center gap-3">
                        <Button asChild variant="primary" className="h-10 px-6">
                            <Link to="/login">{t("public.landing.signIn")}</Link>
                        </Button>
                        {config?.registrationEnabled !== false && (
                            <Button
                                asChild
                                variant="secondary"
                                className="h-10 border border-border bg-background px-6 shadow-none hover:bg-accent dark:bg-muted dark:hover:bg-accent"
                            >
                                <Link to="/register">{t("public.landing.createAccount")}</Link>
                            </Button>
                        )}
                    </div>
                </section>

                <section aria-labelledby="features-heading" className="container mx-auto max-w-6xl px-4 pb-16">
                    <h2 id="features-heading" className="mb-6 text-lg font-semibold">
                        {t("public.landing.featuresHeading")}
                    </h2>
                    <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        {FEATURES.map(({ icon: Icon, titleKey, textKey }) => (
                            <li key={titleKey} className="flex flex-col gap-3 rounded-xl border bg-card p-5 text-card-foreground">
                                <Icon className="size-5 text-primary" aria-hidden="true" />
                                <h3 className="text-base font-semibold leading-snug">{t(titleKey)}</h3>
                                <p className="text-sm text-muted-foreground">{t(textKey)}</p>
                            </li>
                        ))}
                    </ul>
                </section>

                <section aria-labelledby="self-host-heading" className="container mx-auto max-w-6xl px-4 pb-20">
                    <div className="flex flex-col items-center gap-4 rounded-xl border bg-card p-6 text-center sm:p-10">
                        <h2 id="self-host-heading" className="text-xl font-semibold">{t("public.landing.selfHostHeading")}</h2>
                        <p className="max-w-xl text-muted-foreground">{t("public.landing.selfHostBody")}</p>
                        <div className="mt-2 flex flex-wrap justify-center gap-3">
                            <Button asChild variant="secondary" className="h-10 border border-border bg-background px-4 shadow-none hover:bg-accent dark:bg-muted dark:hover:bg-accent sm:h-9">
                                <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
                                    <GitHubIcon className="mr-2" />
                                    {t("public.landing.viewOnGitHub")}
                                </a>
                            </Button>
                            <Button asChild variant="secondary" className="h-10 border border-border bg-background px-4 shadow-none hover:bg-accent dark:bg-muted dark:hover:bg-accent sm:h-9">
                                <Link to="/docs">{t("public.landing.readDocs")}</Link>
                            </Button>
                        </div>
                    </div>
                </section>
            </main>

            <footer className="border-t">
                <div className="container mx-auto flex max-w-6xl flex-col gap-2 px-4 py-6 font-mono text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
                    <p>
                        {t("public.footer.copyright", { year: CURRENT_YEAR })} · {t("public.footer.license")}{" "}
                        <FooterLink href={LICENSE_URL}>AGPL-3.0</FooterLink>
                    </p>
                    <div className="flex items-center gap-3">
                        <FooterLink href={REPO_URL}>{t("public.footer.source")}</FooterLink>
                        <span aria-hidden="true">·</span>
                        <FooterLink to="/docs">{t("public.footer.docs")}</FooterLink>
                        <LanguagePicker />
                    </div>
                </div>
            </footer>
        </div>
    );
}
