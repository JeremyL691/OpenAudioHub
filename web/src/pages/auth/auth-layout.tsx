import type { ComponentProps, ReactNode } from "react";
import { Check } from "lucide-react";
import { Link } from "react-router";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import { LanguagePicker } from "@/components/shell/language-picker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useDocumentMeta } from "../public/brand";

export const REPO_URL = "https://github.com/JeremyL691/OpenAudioHub";
const WORDMARK_GRADIENT = "linear-gradient(135deg, #01ADFB 0%, #2A5DFA 50%, #6B14FB 100%)";

/** Shared frame for the signed-out pages: a brand panel on wide screens, a centered card on phones. */
export function AuthLayout({
    documentTitle,
    title,
    subtitle,
    noindex = false,
    children,
}: {
    /** The document `<title>` for the page, for example "Sign in | OpenAudioHub". */
    documentTitle: string;
    title: string;
    subtitle?: ReactNode;
    noindex?: boolean;
    children: ReactNode;
}) {
    const { t } = useI18n();
    useDocumentMeta(documentTitle, undefined, noindex ? "noindex" : undefined);
    return (
        <>
            <div className="flex min-h-svh flex-col bg-muted/50 dark:bg-background">
                <div className="grid flex-1 bg-muted lg:grid-cols-2">
                    <aside
                        aria-label={t("auth.layout.about")}
                        className="hidden flex-col justify-between border-r border-border bg-transparent p-10 lg:flex xl:p-14"
                    >
                        <a aria-label={t("auth.layout.home")} className="w-fit" href="/">
                            <Wordmark className="text-base" />
                        </a>
                        <div className="max-w-md space-y-6">
                            <img src="/icon.svg" alt="" aria-hidden="true" className="size-14" />
                            <p className="text-2xl leading-snug font-semibold tracking-tight">{t("auth.layout.tagline")}</p>
                            <ul className="space-y-3 text-[13px] text-muted-foreground">
                                <Point>{t("auth.layout.point1")}</Point>
                                <Point>{t("auth.layout.point2")}</Point>
                                <Point>{t("auth.layout.point3")}</Point>
                            </ul>
                        </div>
                        <div className="space-y-3">
                            <LanguagePicker testIdPrefix="auth-panel-language" />
                            <p className="font-mono text-xs text-muted-foreground">{t("auth.layout.license")}</p>
                        </div>
                    </aside>
                    <div className="flex flex-col items-center justify-center gap-6 px-4 py-12 sm:px-8">
                        <a aria-label="OpenAudioHub" className="lg:hidden" href="/">
                            <Wordmark className="text-xl" />
                        </a>
                        <div className="w-full max-w-sm space-y-6">
                            <div className="text-card-foreground flex w-full flex-col gap-6 overflow-hidden rounded-2xl border-0 bg-card p-8 py-8 shadow-card">
                                <div className="space-y-1.5">
                                    <h1 className="text-[28px] font-bold tracking-tight">{title}</h1>
                                    {subtitle ? <p className="text-[13px] text-muted-foreground">{subtitle}</p> : null}
                                </div>
                                {children}
                            </div>
                        </div>
                        <div className="flex flex-col items-center gap-3">
                            <LanguagePicker testIdPrefix="auth-language" />
                            <div className="flex items-center gap-4 font-mono text-xs text-muted-foreground">
                                <a target="_blank" rel="noopener noreferrer" className="hover:text-foreground" href="/docs">
                                    {t("auth.layout.docs")}
                                </a>
                                <span aria-hidden="true" className="text-muted-foreground/40">
                                    ·
                                </span>
                                <a target="_blank" rel="noopener noreferrer" className="hover:text-foreground" href={REPO_URL}>
                                    GitHub
                                </a>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </>
    );
}

function Point({ children }: { children: ReactNode }) {
    return (
        <li className="flex gap-3">
            <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
            <span>{children}</span>
        </li>
    );
}

function Wordmark({ className }: { className: string }) {
    return (
        <span className={cn("inline-flex items-center gap-[0.35em] text-foreground", className)}>
            <img src="/icon.svg" alt="" aria-hidden="true" className="size-[1.2em] shrink-0" />
            <span className="font-semibold tracking-tight text-foreground">
                Open
                <span className="bg-clip-text text-transparent" style={{ backgroundImage: WORDMARK_GRADIENT }}>
                    Audio
                </span>
                Hub
            </span>
        </span>
    );
}

/** A label above a control. `action` (for example "Forgot password?") sits on the label's row, right-aligned. */
export function AuthField({
    id,
    label,
    action,
    children,
}: {
    id: string;
    label: string;
    action?: ReactNode;
    children: ReactNode;
}) {
    const labelEl = (
        <Label htmlFor={id} className="flex items-center gap-2 text-[13px] leading-none font-medium select-none">
            {label}
        </Label>
    );
    return (
        <div className="space-y-2">
            {action ? (
                <div className="flex items-center justify-between">
                    {labelEl}
                    {action}
                </div>
            ) : (
                labelEl
            )}
            {children}
        </div>
    );
}

/** The text input look shared by the auth forms. */
export function AuthInput(props: ComponentProps<typeof Input>) {
    return (
        <Input
            {...props}
            className={cn(
                "h-9 w-full rounded-lg px-3 py-1 text-base shadow-xs sm:h-9 md:text-sm dark:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/30",
                props.className,
            )}
        />
    );
}

/** The informational box used for notices on the auth pages. */
export function AuthNotice({ children, className }: { children: ReactNode; className?: string }) {
    return <div className={cn("space-y-3 rounded-xl bg-muted p-4 text-[13px]", className)}>{children}</div>;
}

/** The centered "Back to sign in" style link under a form. */
export function AuthLink({ to, children }: { to: string; children: ReactNode }) {
    return (
        <div className="text-center text-[13px]">
            <Link className="text-link hover:underline" to={to}>
                {children}
            </Link>
        </div>
    );
}
