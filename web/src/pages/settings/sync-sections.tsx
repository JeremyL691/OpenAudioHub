import { useEffect, useId, useRef, useState } from "react";
import { AudioWaveform, Keyboard } from "lucide-react";
import { setTheme, type ThemeChoice } from "@/lib/theme";
import { Group, ToggleRow, NumberField, Row, SettingSelect, useSettings, type Option, type UserSettings } from "./shared";
import { useI18n } from "@/lib/i18n";

// ---------- sync ----------

const SYNC_INTERVAL_MINUTES = [1, 2, 5, 10, 15, 30];

export function SyncSection() {
    const { t } = useI18n();
    const { settings, save, isSaving } = useSettings();
    const ids = useId();
    const intervals: Option[] = SYNC_INTERVAL_MINUTES.map((minutes) => ({
        value: String(minutes * 60_000),
        label: minutes === 1 ? t("settings.sync.minute") : t("settings.sync.minutes", { count: minutes }),
    }));

    return (
        <div className="grid gap-4">
            <Group label={t("settings.sync.autoSyncGroup")}>
                <ToggleRow
                    id={`${ids}-auto-sync`}
                    field="autoSyncEnabled"
                    label={t("settings.sync.enableAutoSync")}
                    hint={t("settings.sync.enableAutoSyncHint")}
                />
                <Row htmlFor={`${ids}-interval`} label={t("settings.sync.syncInterval")}>
                    <SettingSelect
                        id={`${ids}-interval`}
                        testId="sync-interval"
                        value={String(settings.syncInterval)}
                        disabled={isSaving("syncInterval")}
                        onValueChange={(v) => void save({ syncInterval: Number(v) })}
                        options={intervals}
                        className="w-40"
                    />
                </Row>
                <ToggleRow
                    id={`${ids}-on-mount`}
                    field="syncOnMount"
                    label={t("settings.sync.onMount")}
                    hint={t("settings.sync.onMountHint")}
                />
                <ToggleRow
                    id={`${ids}-on-visibility`}
                    field="syncOnVisibilityChange"
                    label={t("settings.sync.onVisibility")}
                    hint={t("settings.sync.onVisibilityHint")}
                />
            </Group>

            <Group label={t("settings.sync.notificationsGroup")}>
                <ToggleRow
                    id={`${ids}-sync-notifications`}
                    field="syncNotifications"
                    label={t("settings.sync.showSync")}
                    hint={t("settings.sync.showSyncHint")}
                />
            </Group>
        </div>
    );
}

// ---------- playback ----------

const SPEEDS: Option[] = [
    { value: "0.5", label: "0.5x" },
    { value: "0.75", label: "0.75x" },
    { value: "1", label: "1x" },
    { value: "1.25", label: "1.25x" },
    { value: "1.5", label: "1.5x" },
    { value: "2", label: "2x" },
];

const VOLUME_DELAY_MS = 500;

const SHORTCUTS: { labelKey: "settings.playback.shortcutPlayPause" | "settings.playback.shortcutSeekBack" | "settings.playback.shortcutSeekForward" | "settings.playback.shortcutVolumeUp" | "settings.playback.shortcutVolumeDown"; keys: string }[] = [
    { labelKey: "settings.playback.shortcutPlayPause", keys: "Space" },
    { labelKey: "settings.playback.shortcutSeekBack", keys: "←" },
    { labelKey: "settings.playback.shortcutSeekForward", keys: "→" },
    { labelKey: "settings.playback.shortcutVolumeUp", keys: "↑" },
    { labelKey: "settings.playback.shortcutVolumeDown", keys: "↓" },
];

export function PlaybackSection() {
    const { t } = useI18n();
    const { settings, save, isSaving } = useSettings();
    const ids = useId();
    const [volume, setVolume] = useState(settings.defaultVolume);
    const timer = useRef<number | undefined>(undefined);

    // Follow the stored value when it changes (after a save or a revert).
    useEffect(() => {
        setVolume(settings.defaultVolume);
    }, [settings.defaultVolume]);

    useEffect(() => () => window.clearTimeout(timer.current), []);

    return (
        <div className="grid gap-4">
            <Group label={t("settings.playback.audioDefaults")}>
                <Row htmlFor={`${ids}-speed`} label={t("settings.playback.defaultSpeed")}>
                    <SettingSelect
                        id={`${ids}-speed`}
                        testId="playback-speed"
                        value={String(settings.defaultPlaybackSpeed)}
                        disabled={isSaving("defaultPlaybackSpeed")}
                        onValueChange={(v) => void save({ defaultPlaybackSpeed: Number(v) })}
                        options={SPEEDS}
                        className="w-28"
                    />
                </Row>
                <div className="grid gap-2 px-4 py-3">
                    <div className="flex items-center justify-between">
                        <label htmlFor={`${ids}-volume`} className="text-[13px] font-medium">
                            {t("settings.playback.defaultVolume")}
                        </label>
                        <output aria-live="polite" className="font-mono text-xs tabular-nums text-muted-foreground">
                            {volume}%
                        </output>
                    </div>
                    <input
                        id={`${ids}-volume`}
                        data-testid="default-volume"
                        aria-label={t("settings.playback.defaultVolume")}
                        type="range"
                        min={0}
                        max={100}
                        step={1}
                        value={volume}
                        disabled={isSaving("defaultVolume")}
                        onChange={(e) => {
                            const next = Number(e.target.value);
                            setVolume(next);
                            window.clearTimeout(timer.current);
                            timer.current = window.setTimeout(() => {
                                if (next !== settings.defaultVolume) void save({ defaultVolume: next });
                            }, VOLUME_DELAY_MS);
                        }}
                        className="h-2 w-full cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50"
                    />
                </div>
            </Group>

            <Group label={t("settings.playback.behavior")}>
                <ToggleRow
                    id={`${ids}-autoplay`}
                    field="autoPlayNext"
                    label={t("settings.playback.autoplay")}
                    hint={t("settings.playback.autoplayHint")}
                />
            </Group>

            <Group label={t("settings.playback.appearance")}>
                <Row
                    htmlFor={`${ids}-scrubber`}
                    label={
                        <span className="inline-flex items-center gap-2">
                            <AudioWaveform className="size-4 text-muted-foreground" aria-hidden="true" />
                            {t("settings.playback.scrubber")}
                        </span>
                    }
                    hint={t("settings.playback.scrubberHint")}
                >
                    <SettingSelect
                        id={`${ids}-scrubber`}
                        testId="player-scrubber"
                        value={settings.playerScrubber}
                        disabled={isSaving("playerScrubber")}
                        onValueChange={(v) => void save({ playerScrubber: v as UserSettings["playerScrubber"] })}
                        options={[
                            { value: "waveform", label: t("settings.playback.waveform") },
                            { value: "slider", label: t("settings.playback.progressBar") },
                        ]}
                        className="w-44"
                    />
                </Row>
            </Group>

            <section className="grid gap-1.5">
                <div className="px-1">
                    <h2 className="flex items-center gap-1.5 text-[13px] font-semibold text-foreground">
                        <Keyboard className="size-4 text-muted-foreground" aria-hidden="true" />
                        {t("settings.playback.shortcutsTitle")}
                    </h2>
                    <p className="text-xs text-muted-foreground">{t("settings.playback.shortcutsHint")}</p>
                </div>
                <ul className="divide-y divide-border overflow-hidden rounded-xl bg-muted px-4">
                    {SHORTCUTS.map((shortcut) => (
                        <li key={shortcut.labelKey} className="flex items-center justify-between py-3 text-[13px]">
                            <span>{t(shortcut.labelKey)}</span>
                            <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded border border-border bg-background px-1.5 font-mono text-xs">
                                {shortcut.keys}
                            </kbd>
                        </li>
                    ))}
                </ul>
            </section>
        </div>
    );
}

// ---------- display ----------

export function DisplaySection() {
    const { t } = useI18n();
    const { settings, save, isSaving } = useSettings();
    const ids = useId();

    // The account save is best effort: a failure is silent and the page keeps the chosen theme.
    const chooseTheme = (choice: ThemeChoice) => {
        setTheme(choice);
        void save({ theme: choice }, null, true);
    };

    return (
        <div className="divide-y divide-border">
            <Row htmlFor={`${ids}-date-format`} label={t("settings.display.dateFormat")} className="px-0">
                <SettingSelect
                    id={`${ids}-date-format`}
                    testId="date-time-format"
                    value={settings.dateTimeFormat}
                    disabled={isSaving("dateTimeFormat")}
                    onValueChange={(v) => void save({ dateTimeFormat: v as UserSettings["dateTimeFormat"] })}
                    options={[
                        { value: "relative", label: t("settings.display.relative") },
                        { value: "absolute", label: t("settings.display.absolute") },
                        { value: "iso", label: t("settings.display.iso") },
                    ]}
                    className="w-44"
                />
            </Row>
            <Row htmlFor={`${ids}-sort`} label={t("settings.display.sortOrder")} className="px-0">
                <SettingSelect
                    id={`${ids}-sort`}
                    testId="sort-order"
                    value={settings.recordingListSortOrder}
                    disabled={isSaving("recordingListSortOrder")}
                    onValueChange={(v) => void save({ recordingListSortOrder: v as UserSettings["recordingListSortOrder"] })}
                    options={[
                        { value: "newest", label: t("settings.display.sortNewest") },
                        { value: "oldest", label: t("settings.display.sortOldest") },
                        { value: "name", label: t("settings.display.sortName") },
                    ]}
                    className="w-44"
                />
            </Row>
            <div className="grid gap-2 py-3">
                <label htmlFor={`${ids}-items`} className="text-[13px] font-medium">
                    {t("settings.display.itemsPerPage")}
                </label>
                <div className="[&>input]:w-full">
                    <NumberField
                        id={`${ids}-items`}
                        testId="items-per-page"
                        value={settings.itemsPerPage}
                        min={10}
                        max={100}
                        disabled={isSaving("itemsPerPage")}
                        onCommit={(v) => {
                            if (v !== null) void save({ itemsPerPage: v });
                        }}
                    />
                </div>
                <p className="text-xs text-muted-foreground">{t("settings.display.itemsPerPageHint")}</p>
            </div>
            <Row htmlFor={`${ids}-theme`} label={t("settings.display.theme")} className="px-0">
                <SettingSelect
                    id={`${ids}-theme`}
                    testId="theme"
                    value={settings.theme}
                    disabled={isSaving("theme")}
                    onValueChange={(v) => void chooseTheme(v as ThemeChoice)}
                    options={[
                        { value: "light", label: t("settings.display.themeLight") },
                        { value: "dark", label: t("settings.display.themeDark") },
                        { value: "system", label: t("settings.display.themeSystem") },
                    ]}
                    className="w-44"
                />
            </Row>
        </div>
    );
}
