import { useId, useState, type ReactNode } from "react";
import { GitMerge } from "lucide-react";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { RECORDINGS_CHANGED } from "@/lib/recordings";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/spinner";
import { useSettings, type SettingsPatch } from "./shared";
import { useI18n } from "@/lib/i18n";
import { desktopBridge } from "./desktop";

interface ZipMergeSettings {
    zipAutoMerge: boolean;
    zipWatchFolder: string | null;
    zipExportFolder: string | null;
    zipTitleMode: "original" | "date" | "ai";
    zipDeleteAfterMerge: boolean;
}

interface MergeResponse {
    merged: number;
    skipped: number;
    alreadyMerged?: string[];
    errors: string[];
}

const ZIP_TITLE_KEYS: {
    value: "original" | "date" | "ai";
    titleKey:
        | "settings.zipFiles.nameOriginal"
        | "settings.zipFiles.nameDate"
        | "settings.zipFiles.nameAi";
    descriptionKey:
        | "settings.zipFiles.nameOriginalDescription"
        | "settings.zipFiles.nameDateDescription"
        | "settings.zipFiles.nameAiDescription";
}[] = [
    {
        value: "original",
        titleKey: "settings.zipFiles.nameOriginal",
        descriptionKey: "settings.zipFiles.nameOriginalDescription",
    },
    {
        value: "date",
        titleKey: "settings.zipFiles.nameDate",
        descriptionKey: "settings.zipFiles.nameDateDescription",
    },
    {
        value: "ai",
        titleKey: "settings.zipFiles.nameAi",
        descriptionKey: "settings.zipFiles.nameAiDescription",
    },
];

function PlainRow({
    htmlFor,
    label,
    hint,
    badge,
    children,
}: {
    htmlFor?: string;
    label: ReactNode;
    hint?: ReactNode;
    badge?: ReactNode;
    children: ReactNode;
}) {
    return (
        <div className="flex min-h-11 items-center justify-between gap-4 py-2.5">
            <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex flex-wrap items-center gap-2">
                    {htmlFor ? (
                        <label htmlFor={htmlFor} className="text-[13px] font-medium">
                            {label}
                        </label>
                    ) : (
                        <span className="text-[13px] font-medium">{label}</span>
                    )}
                    {badge}
                </div>
                {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
            </div>
            <div className="flex max-w-full shrink-0 items-center gap-2">{children}</div>
        </div>
    );
}

function ComingSoon() {
    const { t } = useI18n();
    return (
        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            {t("settings.zipFiles.comingSoon")}
        </span>
    );
}

export function ZipFilesSection() {
    const { t } = useI18n();
    const { settings, save, isSaving } = useSettings();
    const ids = useId();
    const bridge = desktopBridge();
    const desktop = typeof bridge?.pickFolder === "function";
    const zipCfg = settings as unknown as ZipMergeSettings;
    const [merging, setMerging] = useState(false);
    const [duplicateFiles, setDuplicateFiles] = useState<string[]>([]);

    const chooseWatchFolder = async () => {
        const pickFolder = bridge?.pickFolder;
        if (!pickFolder) return;
        try {
            const path = await pickFolder();
            if (path) {
                await save(
                    { zipWatchFolder: path } as SettingsPatch,
                    t("settings.zipFiles.folderSaveFailed"),
                );
            }
        } catch (err) {
            toast.error(errorMessage(err, t("settings.zipFiles.folderPickerFailed")));
        }
    };

    const chooseExportFolder = async () => {
        const pickFolder = bridge?.pickFolder;
        if (!pickFolder) return;
        try {
            const path = await pickFolder();
            if (path) {
                await save(
                    { zipExportFolder: path } as SettingsPatch,
                    t("settings.zipFiles.folderSaveFailed"),
                );
            }
        } catch (err) {
            toast.error(errorMessage(err, t("settings.zipFiles.folderPickerFailed")));
        }
    };

    const clearExportFolder = async () => {
        await save(
            { zipExportFolder: null } as SettingsPatch,
            t("settings.zipFiles.folderSaveFailed"),
        );
    };

    const runMerge = async (
        duplicateAction: "ask" | "replace" | "keep_both" | "skip",
        onlyFiles?: string[],
    ) => {
        setMerging(true);
        try {
            const res = await api<MergeResponse>("/api/zip/merge", {
                method: "POST",
                json: {
                    duplicateAction,
                    ...(onlyFiles ? { onlyFiles } : {}),
                },
            });
            if (res.merged > 0) {
                window.dispatchEvent(new Event(RECORDINGS_CHANGED));
                toast.success(t("settings.zipFiles.mergeDoneCount", { count: res.merged }));
            } else if (
                duplicateAction !== "ask" ||
                !res.alreadyMerged ||
                res.alreadyMerged.length === 0
            ) {
                if (res.errors.length === 0) {
                    toast.info(t("settings.zipFiles.mergeNone"));
                }
            }
            if (res.errors.length > 0) {
                toast.error(res.errors[0]);
            }
            if (
                duplicateAction === "ask" &&
                res.alreadyMerged &&
                res.alreadyMerged.length > 0
            ) {
                setDuplicateFiles(res.alreadyMerged);
            } else {
                setDuplicateFiles([]);
            }
        } catch (err) {
            toast.error(errorMessage(err, t("settings.zipFiles.mergeFailed")));
        } finally {
            setMerging(false);
        }
    };

    return (
        <div className="divide-y divide-border">
            <div className="divide-y divide-border pb-2">
                {desktop ? (
                    <>
                        <PlainRow
                            htmlFor={`${ids}-zip-auto-merge`}
                            label={t("settings.zipFiles.autoMergeTitle")}
                            hint={t("settings.zipFiles.autoMergeHint")}
                        >
                            <Switch
                                id={`${ids}-zip-auto-merge`}
                                data-testid="zip-auto-merge-switch"
                                disabled={!zipCfg.zipWatchFolder || isSaving("zipAutoMerge")}
                                checked={Boolean(zipCfg.zipAutoMerge)}
                                onCheckedChange={(checked) =>
                                    void save(
                                        { zipAutoMerge: checked } as SettingsPatch,
                                        t("settings.zipFiles.autoMergeSaveFailed"),
                                    )
                                }
                            />
                        </PlainRow>

                        <PlainRow
                            label={t("settings.zipFiles.watchFolder")}
                            hint={t("settings.zipFiles.watchFolderHint")}
                        >
                            <span
                                data-testid="zip-watch-folder"
                                title={zipCfg.zipWatchFolder ?? undefined}
                                className={cn(
                                    "max-w-[260px] truncate text-xs",
                                    zipCfg.zipWatchFolder
                                        ? "font-mono text-foreground"
                                        : "text-muted-foreground",
                                )}
                            >
                                {zipCfg.zipWatchFolder ?? t("settings.zipFiles.noFolderChosen")}
                            </span>
                            <Button
                                variant="secondary"
                                size="sm"
                                data-testid="zip-watch-folder-choose"
                                disabled={isSaving("zipWatchFolder")}
                                onClick={() => void chooseWatchFolder()}
                            >
                                {t("settings.zipFiles.chooseFolder")}
                            </Button>
                        </PlainRow>

                        <PlainRow
                            label={t("settings.zipFiles.exportFolder")}
                            hint={t("settings.zipFiles.exportFolderHint")}
                        >
                            <span
                                data-testid="zip-export-folder"
                                title={zipCfg.zipExportFolder ?? undefined}
                                className={cn(
                                    "max-w-[260px] truncate text-xs",
                                    zipCfg.zipExportFolder
                                        ? "font-mono text-foreground"
                                        : "text-muted-foreground",
                                )}
                            >
                                {zipCfg.zipExportFolder ??
                                    t("settings.zipFiles.sameAsWatchFolder")}
                            </span>
                            {zipCfg.zipExportFolder ? (
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    data-testid="zip-export-folder-clear"
                                    disabled={isSaving("zipExportFolder")}
                                    onClick={() => void clearExportFolder()}
                                >
                                    {t("settings.zipFiles.useWatchFolder")}
                                </Button>
                            ) : null}
                            <Button
                                variant="secondary"
                                size="sm"
                                data-testid="zip-export-folder-choose"
                                disabled={isSaving("zipExportFolder")}
                                onClick={() => void chooseExportFolder()}
                            >
                                {t("settings.zipFiles.chooseFolder")}
                            </Button>
                        </PlainRow>

                        <PlainRow
                            htmlFor={`${ids}-zip-delete-after`}
                            label={t("settings.zipFiles.deleteZipTitle")}
                            hint={t("settings.zipFiles.deleteZipHint")}
                        >
                            <Switch
                                id={`${ids}-zip-delete-after`}
                                data-testid="zip-delete-after-merge-switch"
                                disabled={isSaving("zipDeleteAfterMerge")}
                                checked={Boolean(zipCfg.zipDeleteAfterMerge)}
                                onCheckedChange={(checked) =>
                                    void save({ zipDeleteAfterMerge: checked } as SettingsPatch)
                                }
                            />
                        </PlainRow>

                        <div className="space-y-2 py-3">
                            <span
                                id={`${ids}-zip-file-name`}
                                className="block text-[13px] font-medium"
                            >
                                {t("settings.zipFiles.fileName")}
                            </span>
                            <div
                                role="radiogroup"
                                aria-labelledby={`${ids}-zip-file-name`}
                                data-testid="zip-title-mode"
                                className="divide-y divide-border rounded-xl bg-muted px-4"
                            >
                                {ZIP_TITLE_KEYS.map((option) => {
                                    const inputId = `${ids}-zip-title-mode-${option.value}`;
                                    return (
                                        <label
                                            key={option.value}
                                            htmlFor={inputId}
                                            className="flex cursor-pointer items-start gap-3 py-3 font-normal"
                                        >
                                            <input
                                                type="radio"
                                                id={inputId}
                                                name={`${ids}-zip-title-mode`}
                                                value={option.value}
                                                data-testid={`zip-title-mode-${option.value}`}
                                                checked={zipCfg.zipTitleMode === option.value}
                                                onChange={() =>
                                                    void save({
                                                        zipTitleMode: option.value,
                                                    } as SettingsPatch)
                                                }
                                                className="mt-0.5 size-4 shrink-0 accent-primary"
                                            />
                                            <span className="min-w-0 flex-1 space-y-0.5">
                                                <span className="block text-[13px] font-medium">
                                                    {t(option.titleKey)}
                                                </span>
                                                <span className="block text-xs text-muted-foreground">
                                                    {t(option.descriptionKey)}
                                                </span>
                                            </span>
                                        </label>
                                    );
                                })}
                            </div>
                        </div>
                    </>
                ) : (
                    <PlainRow
                        htmlFor={`${ids}-zip-auto-merge`}
                        label={t("settings.zipFiles.autoMergeTitle")}
                        badge={<ComingSoon />}
                        hint={t("settings.zipFiles.autoMergeDesktopHint")}
                    >
                        <Switch
                            id={`${ids}-zip-auto-merge`}
                            disabled
                            checked={false}
                            onCheckedChange={() => undefined}
                        />
                    </PlainRow>
                )}
            </div>

            {desktop ? (
                <section className="grid gap-3 pt-4">
                    <div className="space-y-2">
                        <span className="text-[13px] font-semibold">
                            {t("settings.zipFiles.manualActions")}
                        </span>
                        <div>
                            <Button
                                variant="secondary"
                                data-testid="zip-merge-now"
                                disabled={!zipCfg.zipWatchFolder || merging}
                                onClick={() => void runMerge("ask")}
                            >
                                {merging ? (
                                    <Spinner label={t("settings.zipFiles.merging")} />
                                ) : (
                                    <GitMerge />
                                )}
                                {merging
                                    ? t("settings.zipFiles.merging")
                                    : t("settings.zipFiles.mergeNow")}
                            </Button>
                        </div>
                        <p className="text-xs text-muted-foreground">
                            {t("settings.zipFiles.mergeHint")}
                        </p>
                    </div>
                </section>
            ) : null}

            <Dialog
                open={duplicateFiles.length > 0}
                onOpenChange={(open) => {
                    if (!open && !merging) setDuplicateFiles([]);
                }}
            >
                <DialogContent data-testid="zip-duplicate-dialog">
                    <DialogTitle>{t("settings.zipFiles.duplicateTitle")}</DialogTitle>
                    <DialogDescription>
                        {t("settings.zipFiles.duplicateDescription")}
                    </DialogDescription>
                    <ul className="max-h-40 space-y-1 overflow-y-auto rounded-lg bg-muted px-3 py-2 font-mono text-xs text-foreground">
                        {duplicateFiles.map((file) => (
                            <li key={file} className="truncate">
                                {file}
                            </li>
                        ))}
                    </ul>
                    <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                        <Button
                            variant="secondary"
                            data-testid="zip-duplicate-skip"
                            disabled={merging}
                            onClick={() => setDuplicateFiles([])}
                        >
                            {t("settings.zipFiles.duplicateSkip")}
                        </Button>
                        <Button
                            variant="secondary"
                            data-testid="zip-duplicate-keep-both"
                            disabled={merging}
                            onClick={() => void runMerge("keep_both", duplicateFiles)}
                        >
                            {t("settings.zipFiles.duplicateKeepBoth")}
                        </Button>
                        <Button
                            variant="primary"
                            data-testid="zip-duplicate-replace"
                            disabled={merging}
                            onClick={() => void runMerge("replace", duplicateFiles)}
                        >
                            {t("settings.zipFiles.duplicateReplace")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
