import { redirect } from "next/navigation";
import { isSettingsSection } from "@/components/settings-nav-config";

interface DashboardPageProps {
    searchParams: Promise<{ settings?: string | string[] }>;
}

/**
 * `/dashboard` forwards to the recordings workstation (`/recordings`). It
 * becomes the overview in T5.1. `?settings=<section>` was linked from the
 * onboarding dialog but never read here, so it now opens that settings section.
 */
export default async function DashboardPage({
    searchParams,
}: DashboardPageProps) {
    const { settings } = await searchParams;
    const section = typeof settings === "string" ? settings : null;
    if (isSettingsSection(section)) redirect(`/settings/${section}`);
    redirect("/recordings");
}
