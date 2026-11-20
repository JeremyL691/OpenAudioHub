const SETTINGS_CHANGED = "oah:settings-changed";

export function notifySettingsChanged(patch: Record<string, unknown>): void {
    window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED, { detail: patch }));
}

export function observeSettingsChanges(listener: (patch: Record<string, unknown>) => void): () => void {
    const onChange = (event: Event) => listener((event as CustomEvent<Record<string, unknown>>).detail);
    window.addEventListener(SETTINGS_CHANGED, onChange);
    return () => window.removeEventListener(SETTINGS_CHANGED, onChange);
}
