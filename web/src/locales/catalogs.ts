/**
 * The interface catalogs. Each namespace is one file per language, so a feature and its
 * translations are changed together. Every key must exist in all four languages; the
 * check in `web/scripts/check-i18n.mjs` enforces that, the placeholder parameters, and that
 * no new hard-coded interface text slips into the components.
 */
import enCommon from "./en/common.json";
import enShell from "./en/shell.json";
import enDashboard from "./en/dashboard.json";
import enLibrary from "./en/library.json";
import enRecording from "./en/recording.json";
import enSettings from "./en/settings.json";
import enAuth from "./en/auth.json";
import enPublic from "./en/public.json";
import enDocs from "./en/docs.json";
import enDesktop from "./en/desktop.json";
import zhCommon from "./zh-CN/common.json";
import zhShell from "./zh-CN/shell.json";
import zhDashboard from "./zh-CN/dashboard.json";
import zhLibrary from "./zh-CN/library.json";
import zhRecording from "./zh-CN/recording.json";
import zhSettings from "./zh-CN/settings.json";
import zhAuth from "./zh-CN/auth.json";
import zhPublic from "./zh-CN/public.json";
import zhDocs from "./zh-CN/docs.json";
import zhDesktop from "./zh-CN/desktop.json";
import jaCommon from "./ja/common.json";
import jaShell from "./ja/shell.json";
import jaDashboard from "./ja/dashboard.json";
import jaLibrary from "./ja/library.json";
import jaRecording from "./ja/recording.json";
import jaSettings from "./ja/settings.json";
import jaAuth from "./ja/auth.json";
import jaPublic from "./ja/public.json";
import jaDocs from "./ja/docs.json";
import jaDesktop from "./ja/desktop.json";
import koCommon from "./ko/common.json";
import koShell from "./ko/shell.json";
import koDashboard from "./ko/dashboard.json";
import koLibrary from "./ko/library.json";
import koRecording from "./ko/recording.json";
import koSettings from "./ko/settings.json";
import koAuth from "./ko/auth.json";
import koPublic from "./ko/public.json";
import koDocs from "./ko/docs.json";
import koDesktop from "./ko/desktop.json";

export const catalogs = {
    en: {
        common: enCommon,
        shell: enShell,
        dashboard: enDashboard,
        library: enLibrary,
        recording: enRecording,
        settings: enSettings,
        auth: enAuth,
        public: enPublic,
        docs: enDocs,
        desktop: enDesktop,
    },
    "zh-CN": {
        common: zhCommon,
        shell: zhShell,
        dashboard: zhDashboard,
        library: zhLibrary,
        recording: zhRecording,
        settings: zhSettings,
        auth: zhAuth,
        public: zhPublic,
        docs: zhDocs,
        desktop: zhDesktop,
    },
    ja: {
        common: jaCommon,
        shell: jaShell,
        dashboard: jaDashboard,
        library: jaLibrary,
        recording: jaRecording,
        settings: jaSettings,
        auth: jaAuth,
        public: jaPublic,
        docs: jaDocs,
        desktop: jaDesktop,
    },
    ko: {
        common: koCommon,
        shell: koShell,
        dashboard: koDashboard,
        library: koLibrary,
        recording: koRecording,
        settings: koSettings,
        auth: koAuth,
        public: koPublic,
        docs: koDocs,
        desktop: koDesktop,
    },
} as const;

type Leaves<T, Prefix extends string = ""> = {
    [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : Leaves<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

export type MessageKey =
    | Leaves<typeof enCommon, "common.">
    | Leaves<typeof enShell, "shell.">
    | Leaves<typeof enDashboard, "dashboard.">
    | Leaves<typeof enLibrary, "library.">
    | Leaves<typeof enRecording, "recording.">
    | Leaves<typeof enSettings, "settings.">
    | Leaves<typeof enAuth, "auth.">
    | Leaves<typeof enPublic, "public.">
    | Leaves<typeof enDocs, "docs.">
    | Leaves<typeof enDesktop, "desktop.">;
