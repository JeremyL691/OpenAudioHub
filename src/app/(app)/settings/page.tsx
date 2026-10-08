import { SettingsIndex } from "@/components/settings/settings-index";
import { requireAuth, requireCompletedOnboarding } from "@/lib/auth-server";

export default async function SettingsPage() {
    const session = await requireAuth();
    await requireCompletedOnboarding(session);

    return <SettingsIndex />;
}
