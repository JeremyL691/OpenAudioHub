import { useEffect, useState, type ComponentType } from "react";
import { Link, Navigate, useLocation, useNavigate, useParams } from "react-router";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import NotFound from "../not-found";
import {
    DEFAULT_SECTION,
    LAST_SECTION_KEY,
    NAV_GROUPS,
    findSection,
    isDesktopApp,
    isReachable,
    navSections,
    type SectionDef,
    type SectionId,
} from "./nav";
import { SectionFrame, SettingSelect, SettingsProvider, type OptionGroup } from "./shared";
import { ProvidersSection } from "./providers";
import { NamingSection, SummarySection, TranscriptionSection } from "./ai-sections";
import { PlaudAccountSection } from "./plaud-account";
import { DisplaySection, PlaybackSection, SyncSection } from "./sync-sections";
import { NotificationsSection } from "./notifications";
import { ExportSection, StorageSection } from "./storage-export";
import { DesktopSection } from "./desktop";

const BODIES: Record<SectionId, ComponentType> = {
    providers: ProvidersSection,
    transcription: TranscriptionSection,
    summary: SummarySection,
    naming: NamingSection,
    "plaud-account": PlaudAccountSection,
    sync: SyncSection,
    playback: PlaybackSection,
    display: DisplaySection,
    storage: StorageSection,
    export: ExportSection,
    notifications: NotificationsSection,
    desktop: DesktopSection,
};

/** The section the viewer opened last, when it is still a valid section. */
function rememberedSection(desktop: boolean): SectionDef | undefined {
    try {
        const saved = findSection(localStorage.getItem(LAST_SECTION_KEY) ?? undefined);
        return saved && isReachable(saved, desktop) ? saved : undefined;
    } catch {
        return undefined;
    }
}

/** /settings has no content of its own. It goes to the hash section, the last one opened, or the default. */
export default function SettingsPage() {
    const { section } = useParams();
    const location = useLocation();
    const desktop = isDesktopApp();

    if (section === undefined) {
        const fromHash = findSection(location.hash.slice(1));
        const target =
            fromHash && isReachable(fromHash, desktop)
                ? fromHash
                : (rememberedSection(desktop) ?? findSection(DEFAULT_SECTION));
        return <Navigate to={`/settings/${target?.id ?? DEFAULT_SECTION}`} replace />;
    }

    const def = findSection(section);
    if (!def || !isReachable(def, desktop)) return <NotFound />;
    return <SettingsLayout section={def} desktop={desktop} />;
}

function SettingsLayout({ section, desktop }: { section: SectionDef; desktop: boolean }) {
    const { t } = useI18n();
    const navigate = useNavigate();
    const [query, setQuery] = useState("");

    useEffect(() => {
        try {
            localStorage.setItem(LAST_SECTION_KEY, section.id);
        } catch {
            // Storage can be blocked. The viewer simply lands on the default next time.
        }
    }, [section.id]);

    const visible = navSections(desktop);
    const needle = query.trim().toLowerCase();
    const matches = (s: SectionDef) =>
        needle === "" ||
        t(s.nameKey).toLowerCase().includes(needle) ||
        t(s.titleKey).toLowerCase().includes(needle) ||
        t(s.descriptionKey).toLowerCase().includes(needle);
    const filtered = visible.filter(matches);

    const groups: OptionGroup[] = (Object.keys(NAV_GROUPS) as (keyof typeof NAV_GROUPS)[])
        .map((key) => ({
            label: t(NAV_GROUPS[key]),
            options: visible.filter((s) => s.group === key).map((s) => ({ value: s.id, label: t(s.nameKey) })),
        }))
        .filter((g) => g.options.length > 0);

    const navGroups = (Object.keys(NAV_GROUPS) as (keyof typeof NAV_GROUPS)[])
        .map((key) => ({ key, label: t(NAV_GROUPS[key]), items: filtered.filter((s) => s.group === key) }))
        .filter((g) => g.items.length > 0);

    const Body = BODIES[section.id];

    return (
        <div className="flex min-h-full min-w-0 flex-1 flex-col lg:flex-row">
            <nav
                data-testid="settings-nav"
                aria-label={t("settings.page.settingsSections")}
                className="hidden w-60 shrink-0 flex-col overflow-y-auto border-r border-border bg-sidebar p-3 lg:flex"
            >
                <input
                    data-testid="settings-search"
                    type="search"
                    aria-label={t("settings.page.searchSettings")}
                    placeholder={t("settings.page.searchPlaceholder")}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    className="h-8 w-full rounded-lg bg-secondary px-2.5 text-[13px] placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                {navGroups.map((group) => (
                    <div key={group.key} className="mt-3 flex flex-col gap-0.5">
                        {group.items.map((item) => {
                            const active = item.id === section.id;
                            const Icon = item.icon;
                            return (
                                <Link
                                    key={item.id}
                                    to={`/settings/${item.id}`}
                                    aria-label={t("settings.nav.settingsSectionAria", { name: t(item.nameKey) })}
                                    aria-current={active ? "page" : undefined}
                                    className={cn(
                                        "flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] text-foreground transition-colors duration-150 ease-out hover:bg-accent",
                                        active && "bg-primary font-medium text-primary-foreground hover:bg-primary/90",
                                    )}
                                >
                                    <span className={cn("flex size-[22px] shrink-0 items-center justify-center rounded-md", item.tile)} aria-hidden="true">
                                        <Icon className="size-3.5 text-white" />
                                    </span>
                                    <span className="truncate">{t(item.nameKey)}</span>
                                </Link>
                            );
                        })}
                    </div>
                ))}
                {filtered.length === 0 ? <p className="px-2 pt-3 text-sm text-muted-foreground">{t("settings.page.noResults")}</p> : null}
            </nav>

            <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex h-13 shrink-0 items-center justify-end border-b border-border px-4 lg:hidden">
                    <SettingSelect
                        aria-label={t("settings.page.selectSection")}
                        value={section.id}
                        groups={groups}
                        onValueChange={(id) => navigate(`/settings/${id}`)}
                        className="h-10 w-[180px] border-transparent bg-muted text-[13px] font-medium shadow-none sm:h-8"
                    />
                </div>
                <div className="flex-1 px-4 py-6 md:px-8 md:py-8">
                    <h1 className="sr-only">{t("settings.page.settingsHeading")}</h1>
                    <SectionFrame section={section}>
                        <SettingsProvider>
                            <Body />
                        </SettingsProvider>
                    </SectionFrame>
                </div>
            </div>
        </div>
    );
}
