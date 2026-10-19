import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { ArrowLeft, ChevronDown, ChevronRight, Moon, PanelLeft, Search, Sun, SquarePen } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/cn";
import { useSession } from "@/lib/session";
import { setTheme, useTheme } from "@/lib/theme";
import { GitHubIcon, REPO_URL, useDocumentMeta } from "../public/brand";
import { DOC_GROUPS, NAV_PAGES, editUrl, findDocPage, renderPage, searchIndex, type DocGroup, type DocPage, type SearchEntry } from "./content";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { LanguagePicker } from "@/components/shell/language-picker";

/** Typography for the rendered Markdown. Applied to the article element. */
const ARTICLE =
    "text-[15px] leading-7 text-foreground " +
    "[&_h1]:mb-6 [&_h1]:text-3xl [&_h1]:font-semibold [&_h1]:tracking-tight " +
    "[&_h2]:mb-4 [&_h2]:mt-12 [&_h2]:scroll-mt-20 [&_h2]:text-2xl [&_h2]:font-semibold [&_h2]:tracking-tight " +
    "[&_h3]:mb-3 [&_h3]:mt-8 [&_h3]:scroll-mt-20 [&_h3]:text-lg [&_h3]:font-semibold " +
    "[&_h4]:mb-2 [&_h4]:mt-6 [&_h4]:scroll-mt-20 [&_h4]:font-semibold " +
    "[&_p]:my-4 [&_ul]:my-4 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-4 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:my-1.5 " +
    "[&_a]:text-link [&_a]:underline [&_a]:underline-offset-4 " +
    "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em] " +
    "[&_pre]:my-6 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-4 [&_pre]:text-[13px] [&_pre]:leading-6 " +
    "[&_pre_code]:bg-transparent [&_pre_code]:p-0 " +
    "[&_table]:my-6 [&_table]:w-full [&_table]:border-collapse [&_table]:text-sm " +
    "[&_th]:border-b [&_th]:py-2 [&_th]:pe-4 [&_th]:text-start [&_th]:font-semibold " +
    "[&_td]:border-b [&_td]:py-2 [&_td]:pe-4 [&_td]:align-top " +
    "[&_blockquote]:my-6 [&_blockquote]:border-s-2 [&_blockquote]:ps-4 [&_blockquote]:text-muted-foreground " +
    "[&_hr]:my-10 [&_hr]:border-border";

/** The translated page title: the title key for this page's URL, else its English title. */
function docTitleKey(page: DocPage): MessageKey {
    return `docs.pages.${page.url === "/docs" ? "index" : page.url.replace(/^\/docs\//, "").replace(/\//g, ".")}` as MessageKey;
}

/** The translated group heading. */
function groupKey(group: DocGroup): MessageKey {
    return `docs.groups.${group}` as MessageKey;
}

/** Decodes a URL fragment. A malformed escape (for example "%E0%A4%A") keeps the raw text instead of throwing. */
function safeDecode(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

/** The docs site at /docs and /docs/<page>. Anonymous, with its own sidebar, search and outline. */
export default function Docs() {
    const { pathname, hash } = useLocation();
    const navigate = useNavigate();
    const { t } = useI18n();
    const page = findDocPage(pathname);
    const [searchOpen, setSearchOpen] = useState(false);
    const [menuOpen, setMenuOpen] = useState(false);

    useDocumentMeta(page ? (page.url === "/docs" ? t("docs.documentTitle") : `${t(docTitleKey(page))} · OpenAudioHub`) : t("docs.descriptionTitle"), undefined, page ? undefined : "noindex");

    // Ctrl or Cmd with K opens search from anywhere on the docs site.
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
                event.preventDefault();
                setSearchOpen(true);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    // A new page starts at the top. A link with a fragment scrolls to its heading.
    useEffect(() => {
        if (hash) {
            const target = document.getElementById(safeDecode(hash.slice(1)));
            if (target) {
                target.scrollIntoView();
                return;
            }
        }
        window.scrollTo(0, 0);
    }, [pathname, hash]);

    const rendered = useMemo(() => (page ? renderPage(page) : null), [page]);

    if (!page || !rendered) return <DocsNotFound />;

    // Internal links are handled here so the docs stay inside the single-page app.
    function onArticleClick(event: MouseEvent<HTMLElement>) {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
        const anchor = (event.target as HTMLElement).closest("a");
        const href = anchor?.getAttribute("href");
        if (!href || !((href.startsWith("/") && !href.startsWith("//")) || href.startsWith("#"))) return;
        event.preventDefault();
        navigate(href);
    }

    const index = NAV_PAGES.findIndex((p) => p.url === page.url);
    const prev = index > 0 ? NAV_PAGES[index - 1] : undefined;
    const next = index >= 0 && index < NAV_PAGES.length - 1 ? NAV_PAGES[index + 1] : undefined;
    const outline = rendered.sections.filter((s) => s.depth === 2);

    return (
        <div className="min-h-svh bg-background text-foreground md:grid md:grid-cols-[268px_minmax(0,1fr)] xl:grid-cols-[268px_minmax(0,1fr)_220px]">
            <aside className="hidden border-e bg-card md:sticky md:top-0 md:flex md:h-svh md:flex-col">
                <DocsSidebar page={page} onNavigate={() => undefined} onSearch={() => setSearchOpen(true)} />
            </aside>

            <main className="min-w-0">
                <header className="sticky top-0 z-10 flex h-12 items-center justify-between gap-2 border-b bg-background/95 px-4 backdrop-blur md:hidden">
                    <Link to="/docs" className="inline-flex items-center gap-2 text-[15px] font-medium">
                        <img src="/icon.svg" alt="" aria-hidden="true" className="size-5 shrink-0" />
                        {t("docs.title")}
                    </Link>
                    <div className="flex items-center">
                        <Button variant="ghost" size="icon" aria-label={t("docs.search")} onClick={() => setSearchOpen(true)}>
                            <Search />
                        </Button>
                        <Button variant="ghost" size="icon" aria-label={t("docs.openSidebar")} onClick={() => setMenuOpen(true)}>
                            <PanelLeft />
                        </Button>
                    </div>
                </header>

                <div className="mx-auto max-w-[720px] px-6 py-10 md:px-12 md:py-14">
                    <article className={ARTICLE} onClick={onArticleClick} dangerouslySetInnerHTML={{ __html: rendered.html }} />

                    <div className="mt-16 flex flex-wrap items-center justify-between gap-3 border-t pt-6">
                        <Button asChild variant="secondary" size="sm" className="border border-border bg-background shadow-none hover:bg-accent">
                            <a href={editUrl(page)} target="_blank" rel="noopener noreferrer">
                                <SquarePen />
                                {t("docs.editOnGitHub")}
                            </a>
                        </Button>
                    </div>

                    {(prev || next) && (
                        <nav aria-label={t("docs.pagination")} className="mt-6 grid gap-3 sm:grid-cols-2">
                            {prev ? <PagerLink page={prev} direction="previous" /> : <span />}
                            {next ? <PagerLink page={next} direction="next" /> : <span />}
                        </nav>
                    )}
                </div>
            </main>

            <aside className="hidden xl:sticky xl:top-0 xl:block xl:h-svh xl:overflow-y-auto xl:py-14 xl:pe-6">
                {outline.length > 0 && (
                    <div className="text-sm">
                        <p className="mb-3 flex items-center gap-2 font-medium text-foreground">{t("docs.onThisPage")}</p>
                        <ul className="space-y-2 border-s ps-3">
                            {outline.map((s) => (
                                <li key={s.id}>
                                    <Link to={`#${s.id}`} className="text-muted-foreground transition-colors hover:text-foreground">
                                        {s.heading}
                                    </Link>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
            </aside>

            <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
                <SheetContent side="left" className="w-[268px] p-0">
                    <SheetTitle className="sr-only">{t("docs.docsNavigation")}</SheetTitle>
                    <div className="flex h-full flex-col bg-card">
                        <DocsSidebar page={page} onNavigate={() => setMenuOpen(false)} onSearch={() => setSearchOpen(true)} />
                    </div>
                </SheetContent>
            </Sheet>

            <SearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
        </div>
    );
}

/** Sidebar: the title, search, back link, the page list in groups, and the footer with GitHub and the theme. */
function DocsSidebar({ page, onNavigate, onSearch }: { page: DocPage; onNavigate: () => void; onSearch: () => void }) {
    const { t } = useI18n();
    const [openGroups, setOpenGroups] = useState<Partial<Record<DocGroup, boolean>>>({});
    const [theme] = useTheme();
    const index = NAV_PAGES.find((p) => !p.group);

    return (
        <>
            <div className="flex flex-col gap-3 p-4 pb-2">
                <Link to="/docs" onClick={onNavigate} className="inline-flex items-center gap-2.5 text-[0.9375rem] font-medium">
                    <img src="/icon.svg" alt="" aria-hidden="true" className="size-5 shrink-0" />
                    {t("docs.title")}
                </Link>
                <button
                    type="button"
                    onClick={onSearch}
                    className="inline-flex w-full items-center gap-2 rounded-lg border bg-muted/50 p-1.5 ps-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                >
                    <Search className="size-4" aria-hidden="true" />
                    {t("docs.search")}
                    <span className="ms-auto inline-flex gap-0.5">
                        <kbd className="rounded-md border bg-background px-1.5 font-mono text-[11px]">⌘</kbd>
                        <kbd className="rounded-md border bg-background px-1.5 font-mono text-[11px]">K</kbd>
                    </span>
                </button>
                <Link
                    to="/dashboard"
                    onClick={onNavigate}
                    className="flex items-center gap-2 rounded-lg p-2 text-sm text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                >
                    <ArrowLeft className="size-4" aria-hidden="true" />
                    {t("docs.backToApp")}
                </Link>
            </div>

            <nav aria-label={t("docs.docsNav")} className="flex-1 space-y-0.5 overflow-y-auto p-4 pt-2 text-sm">
                {index && <NavItem page={index} active={page.url === index.url} onNavigate={onNavigate} />}
                {DOC_GROUPS.map((group) => {
                    const members = NAV_PAGES.filter((p) => p.group === group);
                    if (members.length === 0) return null;
                    const open = openGroups[group] ?? page.group === group;
                    return (
                        <div key={group}>
                            <button
                                type="button"
                                aria-expanded={open}
                                onClick={() => setOpenGroups((s) => ({ ...s, [group]: !open }))}
                                className="flex w-full items-center gap-2 rounded-lg p-2 text-start text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                            >
                                {t(groupKey(group))}
                                {open ? <ChevronDown className="ms-auto size-4" aria-hidden="true" /> : <ChevronRight className="ms-auto size-4" aria-hidden="true" />}
                            </button>
                            {open && (
                                <div className="ms-2.5 space-y-0.5 border-s ps-2">
                                    {members.map((p) => (
                                        <NavItem key={p.url} page={p} active={page.url === p.url} onNavigate={onNavigate} />
                                    ))}
                                </div>
                            )}
                        </div>
                    );
                })}
            </nav>

            <div className="flex items-center justify-between gap-2 border-t p-3">
                <a
                    href={REPO_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="GitHub"
                    className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                    <GitHubIcon />
                </a>
                <LanguagePicker />
                <div role="group" aria-label={t("docs.theme")} className="inline-flex items-center gap-0.5 rounded-lg border bg-background p-0.5">
                    <ThemeButton label={t("docs.themeLight")} value="light" current={theme} icon={<Sun className="size-3.5" />} />
                    <ThemeButton label={t("docs.themeDark")} value="dark" current={theme} icon={<Moon className="size-3.5" />} />
                </div>
            </div>
        </>
    );
}

function NavItem({ page, active, onNavigate }: { page: DocPage; active: boolean; onNavigate: () => void }) {
    const { t } = useI18n();
    return (
        <Link
            to={page.url}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
                "flex items-center rounded-lg p-2 text-start transition-colors hover:bg-accent/50",
                active ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:text-foreground",
            )}
        >
            {t(docTitleKey(page))}
        </Link>
    );
}

function ThemeButton({ label, value, current, icon }: { label: string; value: "light" | "dark"; current: string; icon: ReactNode }) {
    const active = current === value;
    return (
        <button
            type="button"
            aria-label={label}
            aria-pressed={active}
            onClick={() => setTheme(value)}
            className={cn(
                "inline-flex size-6 items-center justify-center rounded-md transition-colors",
                active ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
        >
            {icon}
        </button>
    );
}

function PagerLink({ page, direction }: { page: DocPage; direction: "previous" | "next" }) {
    const { t } = useI18n();
    return (
        <Link
            to={page.url}
            className={cn(
                "flex flex-col gap-1 rounded-xl border p-4 transition-colors hover:bg-accent/50",
                direction === "next" ? "items-end text-end sm:col-start-2" : "items-start text-start",
            )}
        >
            <span className="text-xs text-muted-foreground">{direction === "previous" ? t("docs.previous") : t("docs.next")}</span>
            <span className="font-medium">{t(docTitleKey(page))}</span>
        </Link>
    );
}

/** Search over every section of the docs. Results open the section they came from. */
function SearchDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
    const { t } = useI18n();
    const [query, setQuery] = useState("");
    const navigate = useNavigate();
    const results = useMemo(() => (open ? searchResults(query) : []), [open, query]);

    function pick(entry: SearchEntry) {
        onOpenChange(false);
        setQuery("");
        navigate(entry.url);
    }

    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                onOpenChange(next);
                if (!next) setQuery("");
            }}
        >
            <DialogContent className="top-[20%] max-w-xl translate-y-0 gap-0 p-0 sm:max-w-xl">
                <DialogTitle className="sr-only">{t("docs.searchTitle")}</DialogTitle>
                <DialogDescription className="sr-only">{t("docs.searchDescription")}</DialogDescription>
                <div className="flex items-center gap-2 border-b px-4">
                    <Search className="size-4 text-muted-foreground" aria-hidden="true" />
                    <input
                        autoFocus
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder={t("docs.searchPlaceholder")}
                        aria-label={t("docs.searchTitle")}
                        className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                    />
                </div>
                <ul className="max-h-[360px] overflow-y-auto p-2 text-sm">
                    {query.trim() && results.length === 0 && (
                        <li className="p-4 text-center text-muted-foreground">{t("docs.searchEmpty")}</li>
                    )}
                    {results.map((entry) => (
                        <li key={entry.url}>
                            <button
                                type="button"
                                onClick={() => pick(entry)}
                                className="flex w-full flex-col items-start gap-0.5 rounded-lg p-3 text-start transition-colors hover:bg-accent"
                            >
                                <span className="text-xs text-muted-foreground">
                                    {entry.heading !== entry.pageTitle && ` › ${entry.heading}`}
                                </span>
                                <span className="line-clamp-2 text-muted-foreground">{snippet(entry.text, query)}</span>
                            </button>
                        </li>
                    ))}
                </ul>
            </DialogContent>
        </Dialog>
    );
}

function searchResults(query: string): SearchEntry[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const hits: SearchEntry[] = [];
    for (const entry of searchIndex()) {
        if (entry.heading.toLowerCase().includes(q) || entry.text.toLowerCase().includes(q) || entry.pageTitle.toLowerCase().includes(q)) {
            hits.push(entry);
            if (hits.length >= 12) break;
        }
    }
    return hits;
}

/** Text around the first match, with the match left in place. The text is shown as plain text, never as HTML. */
function snippet(text: string, query: string): string {
    const clean = text.replace(/[*_`#>|]/g, "").replace(/\]\([^)]*\)/g, "]").replace(/\s+/g, " ").trim();
    const q = query.trim().toLowerCase();
    if (!q) return clean.slice(0, 140);
    const at = clean.toLowerCase().indexOf(q);
    if (at < 0) return clean.slice(0, 140);
    const start = Math.max(0, at - 50);
    return `${start > 0 ? "…" : ""}${clean.slice(start, at + 90)}`;
}

/** Shown for any docs URL with no page. The copy matches the app's not-found page. */
function DocsNotFound() {
    const { t } = useI18n();
    const { status } = useSession();
    useDocumentMeta(t("docs.descriptionTitle"), undefined, "noindex");
    const signedIn = status === "authenticated";
    return (
        <div className="flex min-h-svh flex-col items-center justify-center gap-4 px-4 text-center">
            <p className="font-mono text-sm text-muted-foreground">404</p>
            <h1 className="text-2xl font-semibold tracking-tight">{t("auth.notFound.title")}</h1>
            <p className="max-w-md text-muted-foreground">{t("auth.notFound.body")}</p>
            <Button asChild variant="primary" className="mt-2 h-10 px-6">
                <Link to={signedIn ? "/recordings" : "/"}>{signedIn ? t("auth.notFound.toRecordings") : t("auth.notFound.toHome")}</Link>
            </Button>
        </div>
    );
}
