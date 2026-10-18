import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { errorMessage } from "@/lib/api";
import { Switch } from "@/components/ui/switch";
import { Group, Loading, LoadError, Row, SettingSelect } from "./shared";

/** The preferences bridge the desktop app exposes to its window. */
interface DesktopPreferences {
    closeAction: "background" | "quit";
    showTray: boolean;
    launchAtLogin: boolean;
}

/** The bridge reports which optional capabilities the desktop app has, such as `pickFolder` and native saving of text exports. */
export interface DesktopBridge {
    version?: number;
    getPreferences: () => Promise<DesktopPreferences> | DesktopPreferences;
    setPreferences: (updates: Partial<DesktopPreferences>) => Promise<DesktopPreferences> | DesktopPreferences;
    pickFolder?: () => Promise<string | null>;
    saveTextFile?: (filename: string, content: string) => Promise<boolean>;
}

export function desktopBridge(): DesktopBridge | null {
    return (window as unknown as { __openaudiohubDesktop?: DesktopBridge }).__openaudiohubDesktop ?? null;
}

/** Shown only in the desktop app. Its controls call the desktop bridge, not the server. */
export function DesktopSection() {
    const ids = useId();
    const [prefs, setPrefs] = useState<DesktopPreferences | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        const bridge = desktopBridge();
        if (!bridge) {
            setLoadError("The desktop app is not available.");
            return;
        }
        let alive = true;
        setLoadError(null);
        Promise.resolve(bridge.getPreferences())
            .then((next) => {
                if (alive) setPrefs(next);
            })
            .catch((err: unknown) => {
                if (alive) setLoadError(errorMessage(err, "Could not read the preferences."));
            });
        return () => {
            alive = false;
        };
    }, [attempt]);

    const update = async (patch: Partial<DesktopPreferences>) => {
        const bridge = desktopBridge();
        if (!bridge || !prefs) return;
        const previous = prefs;
        setPrefs({ ...prefs, ...patch });
        try {
            setPrefs(await bridge.setPreferences(patch));
        } catch (err) {
            setPrefs(previous);
            toast.error(errorMessage(err, "Could not save the preferences."));
        }
    };

    if (loadError) {
        return <LoadError message={loadError} onRetry={() => setAttempt((n) => n + 1)} />;
    }
    if (!prefs) return <Loading label="Loading desktop settings" />;

    return (
        <div className="grid gap-6">
            <Group>
                <Row htmlFor={`${ids}-tray`} label="Show in the menu bar">
                    <Switch
                        id={`${ids}-tray`}
                        data-testid="desktop-show-tray-switch"
                        checked={prefs.showTray}
                        onCheckedChange={(next) => void update({ showTray: next })}
                    />
                </Row>
                <Row htmlFor={`${ids}-close`} label="When the window is closed">
                    <SettingSelect
                        id={`${ids}-close`}
                        testId="desktop-close-action"
                        value={prefs.closeAction}
                        onValueChange={(v) => void update({ closeAction: v as DesktopPreferences["closeAction"] })}
                        options={[
                            { value: "background", label: "Keep running in the background" },
                            { value: "quit", label: "Quit the app" },
                        ]}
                        className="w-64 max-w-full"
                    />
                </Row>
                <Row
                    htmlFor={`${ids}-login`}
                    label="Launch at login"
                    hint="Start OpenAudioHub when you sign in to your Mac. It starts without a window and stays in the menu bar."
                >
                    <Switch
                        id={`${ids}-login`}
                        data-testid="desktop-launch-at-login"
                        checked={prefs.launchAtLogin}
                        onCheckedChange={(next) => void update({ launchAtLogin: next })}
                    />
                </Row>
            </Group>
        </div>
    );
}
