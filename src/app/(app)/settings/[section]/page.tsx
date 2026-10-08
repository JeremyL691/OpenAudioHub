import { notFound } from "next/navigation";
import { SettingsPage } from "@/components/settings/settings-page";
import { isSettingsSection } from "@/components/settings-nav-config";
import { listUserProviders } from "@/lib/ai/list-providers";
import { requireAuth, requireCompletedOnboarding } from "@/lib/auth-server";

interface SettingsSectionPageProps {
    params: Promise<{ section: string }>;
}

export default async function SettingsSectionPage({
    params,
}: SettingsSectionPageProps) {
    const session = await requireAuth();
    await requireCompletedOnboarding(session);

    const { section } = await params;
    if (!isSettingsSection(section)) notFound();

    const providers = await listUserProviders(session.user.id);

    return <SettingsPage section={section} initialProviders={providers} />;
}
