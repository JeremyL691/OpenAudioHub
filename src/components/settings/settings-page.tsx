"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect } from "react";
import { useDialogs, useSyncStatus } from "@/components/app-shell/providers";
import { type Provider, SettingsContent } from "@/components/settings-content";
import { SETTINGS_STORAGE_KEY } from "@/components/settings-nav-config";
import { SettingsNavMobile } from "@/components/settings-nav-mobile";
import { SettingsNavSidebar } from "@/components/settings-nav-sidebar";
import type { SettingsSection } from "@/types/settings";

interface SettingsPageProps {
    section: SettingsSection;
    initialProviders: Provider[];
}

/**
 * One settings section per URL (`/settings/<section>`). The nav is made of
 * links, so the section is in the address bar and survives a reload.
 */
export function SettingsPage({ section, initialProviders }: SettingsPageProps) {
    const { push, refresh } = useRouter();
    const { setOnboardingOpen } = useDialogs();
    const { manualSync } = useSyncStatus();

    // Remember the section so `/settings` can return to it.
    useEffect(() => {
        try {
            localStorage.setItem(SETTINGS_STORAGE_KEY, section);
        } catch {
            // Storage can be blocked; the links still work without it.
        }
    }, [section]);

    const handleSectionChange = useCallback(
        (next: SettingsSection) => push(`/settings/${next}`),
        [push],
    );

    return (
        <div className="flex min-w-0 flex-1">
            <h1 className="sr-only">Settings</h1>
            <SettingsNavSidebar activeSection={section} />
            <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex h-14 shrink-0 items-center justify-end border-b px-4 md:hidden">
                    <SettingsNavMobile
                        activeSection={section}
                        onSectionChange={handleSectionChange}
                    />
                </div>
                <main className="flex-1 overflow-y-auto p-4 md:p-6">
                    <div
                        key={section}
                        data-testid={`settings-section-${section}`}
                        className="mx-auto flex max-w-3xl animate-in flex-col gap-4 fade-in-0 duration-200"
                    >
                        <SettingsContent
                            activeSection={section}
                            initialProviders={initialProviders}
                            onReRunOnboarding={() => setOnboardingOpen(true)}
                            onPlaudReconnected={() => {
                                refresh();
                                void manualSync();
                            }}
                        />
                    </div>
                </main>
            </div>
        </div>
    );
}
