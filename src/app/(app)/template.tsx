import { eq } from "drizzle-orm";
import { AppSettingsSync } from "@/components/app-shell/providers";
import { db } from "@/db";
import { userSettings } from "@/db/schema";
import { requireAuth } from "@/lib/auth-server";
import { initialSettingsFromRow } from "@/lib/settings/initial-settings";

/**
 * Templates re-render on every navigation within the group; layouts do not.
 * Passing the saved settings through here keeps the shell (sync loop, onboarding
 * gate) in step with the server, without touching each settings form.
 */
export default async function AppTemplate({
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

    return (
        <>
            <AppSettingsSync settings={initialSettingsFromRow(settingsRow)} />
            {children}
        </>
    );
}
