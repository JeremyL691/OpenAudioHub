import { useEffect, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import { AudioLines, BookOpen, Clock, Github, LayoutGrid, Mic, Settings, Star, Upload, type LucideIcon } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import { collectionCounts, useShellData } from "./shell-data";

const REPO_URL = "https://github.com/JeremyL691/OpenAudioHub";
const ISSUES_URL = `${REPO_URL}/issues/new`;

const itemClass =
    "flex h-10 items-center gap-2.5 rounded-md p-2 px-2.5 text-[13px] transition-colors duration-150 ease-out motion-reduce:transition-none md:h-8 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

interface NavItemProps {
    testId: string;
    to: string;
    icon: LucideIcon;
    label: string;
    count?: number | null;
    active: boolean;
    onNavigate?: () => void;
}

function NavItem({ testId, to, icon: Icon, label, count, active, onNavigate }: NavItemProps) {
    return (
        <Link
            to={to}
            data-testid={testId}
            aria-current={active ? "page" : undefined}
            onClick={onNavigate}
            className={cn(itemClass, active ? "bg-sidebar-accent font-semibold text-sidebar-accent-foreground" : "text-foreground")}
        >
            <Icon aria-hidden="true" className={cn("size-4 shrink-0", active ? "text-primary" : "text-foreground")} />
            <span className="min-w-0 truncate">{label}</span>
            {count !== undefined && count !== null ? (
                <span className="ml-auto text-xs tabular-nums text-muted-foreground">{count}</span>
            ) : null}
        </Link>
    );
}

export interface SidebarNavProps {
    /** Called after a link is followed, so the mobile sheet can close. */
    onNavigate?: () => void;
}

/** The sidebar: logo, the main items, the Collections group, then Settings, Docs and the footer. Rendered once, docked or in the sheet. */
export function SidebarNav({ onNavigate }: SidebarNavProps) {
    const { pathname } = useLocation();
    const [params] = useSearchParams();
    const { recordings } = useShellData();
    const { t } = useI18n();
    const counts = recordings ? collectionCounts(recordings) : null;
    const collection = params.get("collection");
    const onLibrary = pathname === "/recordings";
    const libraryActive = onLibrary && !collection;

    const collections: { id: "starred" | "recent" | "plaud" | "uploaded"; label: string; icon: LucideIcon; count: number | null }[] = [
        { id: "starred", label: t("shell.nav.starred"), icon: Star, count: counts?.starred ?? null },
        { id: "recent", label: t("shell.nav.last7Days"), icon: Clock, count: counts?.recent ?? null },
        { id: "plaud", label: t("shell.nav.fromPlaud"), icon: Mic, count: counts?.plaud ?? null },
        { id: "uploaded", label: t("shell.nav.uploaded"), icon: Upload, count: counts?.uploaded ?? null },
    ];

    return (
        <nav aria-label={t("shell.nav.mainNavigation")} data-testid="app-sidebar" className="flex h-full min-h-0 flex-col overflow-y-auto">
            <div className="px-4 pb-3 pt-4">
                <Link
                    to="/dashboard"
                    aria-label={t("shell.nav.home")}
                    onClick={onNavigate}
                    className="inline-flex w-fit items-center gap-[0.35em] rounded-md text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                    <img aria-hidden="true" src="/icon.svg" alt="" className="size-[1.2em] shrink-0" />
                    <span className="font-semibold tracking-tight text-foreground">
                        Open
                        <span
                            className="bg-clip-text text-transparent"
                            style={{ backgroundImage: "linear-gradient(135deg, #01ADFB 0%, #2A5DFA 50%, #6B14FB 100%)" }}
                        >
                            Audio
                        </span>
                        Hub
                    </span>
                </Link>
            </div>

            <div className="flex flex-col gap-1 p-2">
                <NavItem testId="nav-overview" to="/dashboard" icon={LayoutGrid} label={t("shell.nav.dashboard")} active={pathname === "/dashboard"} onNavigate={onNavigate} />
                <NavItem
                    testId="nav-recordings"
                    to="/recordings"
                    icon={AudioLines}
                    label={t("shell.nav.library")}
                    count={recordings ? recordings.length : null}
                    active={libraryActive}
                    onNavigate={onNavigate}
                />
            </div>

            <div className="flex flex-col p-2">
                <p className="px-2.5 pt-6 text-[11px] font-semibold text-muted-foreground">{t("shell.nav.collections")}</p>
                <div className="flex flex-col gap-1">
                    {collections.map((item) => (
                        <NavItem
                            key={item.id}
                            testId={`nav-collection-${item.id}`}
                            to={`/recordings?collection=${item.id}`}
                            icon={item.icon}
                            label={item.label}
                            count={item.count}
                            active={onLibrary && collection === item.id}
                            onNavigate={onNavigate}
                        />
                    ))}
                </div>
            </div>

            <div className="mt-auto flex flex-col gap-1 p-2">
                <Link
                    to="/settings"
                    data-testid="nav-settings"
                    aria-current={pathname.startsWith("/settings") ? "page" : undefined}
                    onClick={onNavigate}
                    className={cn(itemClass, pathname.startsWith("/settings") ? "bg-sidebar-accent font-semibold text-sidebar-accent-foreground" : "text-muted-foreground")}
                >
                    <Settings aria-hidden="true" className="size-4 shrink-0" />
                    <span>{t("shell.nav.settings")}</span>
                </Link>
                <Link
                    to="/docs"
                    data-testid="nav-docs"
                    aria-current={pathname.startsWith("/docs") ? "page" : undefined}
                    onClick={onNavigate}
                    className={cn(itemClass, "text-muted-foreground")}
                >
                    <BookOpen aria-hidden="true" className="size-4 shrink-0" />
                    <span>{t("shell.nav.docs")}</span>
                </Link>
            </div>

            <SidebarFooter />
        </nav>
    );
}

function SidebarFooter() {
    const [version, setVersion] = useState<string | null>(null);
    const { t } = useI18n();
    useEffect(() => {
        api<{ version?: string }>("/api/health")
            .then((body) => setVersion(body.version ?? null))
            .catch(() => setVersion(null));
    }, []);
    const tag = version ? `v${version}` : "";

    return (
        <div data-testid="sidebar-footer" className="flex flex-col gap-3 px-4 pb-3 pt-3 font-mono text-[11px] leading-snug text-muted-foreground">
            <p>
                {t("shell.footer.copyright")}
                <br />
                {t("shell.footer.license")}
            </p>
            <div className="flex items-center gap-3">
                {version ? (
                    <a
                        href={`${REPO_URL}/releases/tag/${tag}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={t("shell.footer.releaseNotes", { tag })}
                        className="transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                        {tag}
                    </a>
                ) : null}
                <a href={ISSUES_URL} target="_blank" rel="noopener noreferrer" className="transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    {t("shell.footer.reportBug")}
                </a>
                <a
                    href={REPO_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={t("shell.footer.viewSource")}
                    className="transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                    <Github className="size-4" aria-hidden="true" />
                </a>
            </div>
        </div>
    );
}
