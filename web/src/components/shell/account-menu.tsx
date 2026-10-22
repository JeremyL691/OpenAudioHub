import { useNavigate } from "react-router";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip } from "@/components/ui/tooltip";
import { Kbd } from "@/components/ui/kbd";
import { Keyboard, Languages, LogOut, Monitor, Moon, Plug, RefreshCw, Settings, Sun } from "lucide-react";
import { formatRelative } from "@/lib/format";
import { signOut, useSession } from "@/lib/session";
import { setTheme, useTheme, type ThemeChoice } from "@/lib/theme";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { desktopApp } from "@/lib/desktop-app";
import { usePublicConfig } from "@/lib/public-config";
import { useShellData } from "./shell-data";
import { LANGUAGE_ITEMS, chooseLocale } from "./language-picker";

/** Opened by the keyboard shortcut dialog (spec/ui-library.md 5). */
export const OPEN_SHORTCUTS_EVENT = "oah:open-shortcuts";

type SyncTone = "ok" | "failed" | "syncing" | "idle";

const RING: Record<SyncTone, string> = {
    ok: "border-success",
    failed: "border-destructive",
    syncing: "border-primary motion-safe:animate-pulse",
    idle: "border-border",
};

/** The account button at the right of the top bar: sync state, theme, language, Settings, log out. */
export function AccountMenu() {
    const { connection, sync, syncNow, updateSettings } = useShellData();
    const session = useSession();
    const [theme] = useTheme();
    const { locale, setLocale, t } = useI18n();
    const navigate = useNavigate();
    const config = usePublicConfig();

    const THEME_ITEMS: { value: ThemeChoice; label: string; icon: typeof Sun }[] = [
        { value: "light", label: t("shell.account.themeLight"), icon: Sun },
        { value: "dark", label: t("shell.account.themeDark"), icon: Moon },
        { value: "system", label: t("shell.account.themeAuto"), icon: Monitor },
    ];

    const SUFFIX: Record<SyncTone, string> = {
        ok: t("shell.account.suffixOk"),
        failed: t("shell.account.suffixFailed"),
        syncing: t("shell.account.suffixSyncing"),
        idle: t("shell.account.suffixIdle"),
    };

    const email = session.data?.user.email ?? "";
    // The desktop app and a single-account server have one local account and no sign-out (spec/ui-app.md section 9).
    const desktop = desktopApp() !== null;
    const local = desktop || config?.singleAccount === true;
    const initial = email ? email.charAt(0).toUpperCase() : "?";
    const tone: SyncTone = sync.status === "syncing" ? "syncing" : sync.status === "failed" ? "failed" : sync.status === "ok" ? "ok" : "idle";
    const needsReconnect = Boolean(connection?.needsReconnect);

    let tooltip: string;
    if (needsReconnect) tooltip = t("shell.account.reconnectTooltip");
    else if (tone === "syncing") tooltip = t("shell.account.syncingTooltip");
    else if (tone === "failed") tooltip = t("shell.account.failedTooltip", { reason: sync.error ?? t("shell.account.unknownError") });
    else if (tone === "ok" && sync.lastSyncAt) tooltip = t("shell.account.lastSyncedTooltip", { time: formatRelative(sync.lastSyncAt) });
    else tooltip = t("shell.account.idleTooltip");

    const chooseTheme = (choice: ThemeChoice) => {
        setTheme(choice);
        // Best effort: a failed save keeps the choice in this browser.
        updateSettings({ theme: choice }).catch(() => undefined);
    };

    return (
        <DropdownMenu>
            <Tooltip content={tooltip} side="bottom">
                <DropdownMenuTrigger asChild>
                    <button
                        type="button"
                        data-testid="user-menu"
                        data-sync-state={tone}
                        aria-label={`${t("shell.account.aria")}${SUFFIX[tone]}`}
                        className="relative grid size-10 shrink-0 place-items-center rounded-full border border-border bg-muted text-sm font-semibold text-foreground transition-colors duration-150 ease-out hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:size-8"
                    >
                        <span aria-hidden="true">{initial}</span>
                        <span aria-hidden="true" className={cn("pointer-events-none absolute -inset-[3px] rounded-full border-2", RING[tone])} />
                    </button>
                </DropdownMenuTrigger>
            </Tooltip>

            <DropdownMenuContent align="end" className="w-72 p-0">
                <div className="flex items-center gap-3 border-b border-border p-3">
                    <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                        {initial}
                    </span>
                    <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{local ? "OpenAudioHub" : email || t("shell.account.signedIn")}</p>
                        <p className="text-xs text-muted-foreground">{local ? t("shell.account.localAccount") : t("shell.account.signedIn")}</p>
                    </div>
                </div>

                <div className="p-1">
                    <DropdownMenuItem disabled={tone === "syncing"} onSelect={() => void syncNow()}>
                        <RefreshCw />
                        <span className="flex-1">{t("shell.account.syncNow")}</span>
                    </DropdownMenuItem>
                    {needsReconnect ? (
                        <DropdownMenuItem onSelect={() => navigate("/settings/plaud-account")}>
                            <Plug />
                            <span className="flex-1">{t("shell.account.reconnectPlaud")}</span>
                        </DropdownMenuItem>
                    ) : null}
                    <DropdownMenuItem onSelect={() => navigate("/settings")}>
                        <Settings />
                        <span className="flex-1">{t("shell.account.settings")}</span>
                        <Kbd className="h-5 px-1 text-[10px]">,</Kbd>
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => window.dispatchEvent(new Event(OPEN_SHORTCUTS_EVENT))}>
                        <Keyboard />
                        <span className="flex-1">{t("shell.account.keyboardShortcuts")}</span>
                        <Kbd className="h-5 px-1 text-[10px]">?</Kbd>
                    </DropdownMenuItem>
                </div>

                <DropdownMenuLabel>{t("shell.account.theme")}</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={theme} onValueChange={(value) => chooseTheme(value as ThemeChoice)}>
                    {THEME_ITEMS.map((item) => {
                        const Icon = item.icon;
                        return (
                            <DropdownMenuRadioItem
                                key={item.value}
                                value={item.value}
                                onSelect={(event) => event.preventDefault()}
                            >
                                <Icon className="mr-2 size-3.5" aria-hidden="true" />
                                {item.label}
                            </DropdownMenuRadioItem>
                        );
                    })}
                </DropdownMenuRadioGroup>

                <DropdownMenuLabel className="flex items-center gap-2">
                    <Languages className="size-3.5" aria-hidden="true" />
                    {t("shell.account.language")}
                </DropdownMenuLabel>
                <DropdownMenuRadioGroup value={locale} onValueChange={(value) => chooseLocale(value as typeof locale, setLocale)}>
                    {LANGUAGE_ITEMS.map((item) => (
                        <DropdownMenuRadioItem
                            key={item.value}
                            value={item.value}
                            data-testid={`language-option-${item.value}`}
                            onSelect={(event) => event.preventDefault()}
                        >
                            {item.label}
                        </DropdownMenuRadioItem>
                    ))}
                </DropdownMenuRadioGroup>

                {local ? null : (
                    <>
                        <DropdownMenuSeparator className="my-0" />
                        <div className="p-1">
                            <DropdownMenuItem
                                variant="destructive"
                                onSelect={() => {
                                    // A full load of "/" after sign-out, so the signed-out state starts clean.
                                    void signOut();
                                }}
                            >
                                <LogOut />
                                <span className="flex-1">{t("shell.account.logOut")}</span>
                            </DropdownMenuItem>
                        </div>
                    </>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
