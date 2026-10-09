import { redirect } from "next/navigation";
import { LandingPage } from "@/components/landing/landing-page";
import { getSession } from "@/lib/auth-server";
import { isDesktopMode } from "@/lib/desktop/mode";
import { env } from "@/lib/env";

/**
 * Public front page. Signed-in visitors go to the app; everyone else sees the
 * landing page, with Register hidden when the server disables registration.
 * The desktop app has no landing page, so it always goes to the app.
 */
export default async function HomePage() {
    if (isDesktopMode()) redirect("/dashboard");
    const session = await getSession();
    if (session?.user) redirect("/dashboard");

    return <LandingPage registrationEnabled={!env.DISABLE_REGISTRATION} />;
}
