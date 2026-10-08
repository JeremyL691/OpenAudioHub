import { eq } from "drizzle-orm";
import { Suspense } from "react";
import { AppShell } from "@/components/app-shell/app-shell";
import { AppShellProviders } from "@/components/app-shell/providers";
import { UpdateBadge } from "@/components/update-badge";
import { db } from "@/db";
import { userSettings } from "@/db/schema";
import { requireAuth } from "@/lib/auth-server";
import { BRAND } from "@/lib/brand";
import { initialSettingsFromRow } from "@/lib/settings/initial-settings";

/**
 * Shell for every signed-in page. Loads the session and saved settings on a
 * full load. `template.tsx` refreshes the settings on each navigation.
 */
export default async function AppLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const session = await requireAuth();
    const [settingsRow] = await db
        .select()
        .from(userSettings)
        .where(eq(userSettings.userId, session.user.id))
        .limit(1);
    const initialSettings = initialSettingsFromRow(settingsRow);
    const currentYear = new Date().getFullYear();

    return (
        <AppShellProviders initialSettings={initialSettings}>
            <AppShell
                userEmail={session.user.email ?? null}
                initialTheme={initialSettings.theme}
                sidebarFooter={
                    <>
                        {/* Update notice. Suspended with a null fallback so a
                            cold GitHub-API cache doesn't block the sidebar. */}
                        <Suspense fallback={null}>
                            <UpdateBadge />
                        </Suspense>
                        <p className="font-mono leading-snug">
                            © {currentYear} {BRAND.copyrightHolder}
                            <br />
                            {BRAND.attribution}
                        </p>
                    </>
                }
            >
                {children}
            </AppShell>
        </AppShellProviders>
    );
}
