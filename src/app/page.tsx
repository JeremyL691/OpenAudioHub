import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth-server";

// Temporary root until the public landing page lands (PLAN T4.4): signed-in
// users go to their recordings, everyone else to sign-in.
export default async function HomePage() {
    const session = await getSession();
    redirect(session?.user ? "/recordings" : "/login");
}
