import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { acquireDesktopUserLock } from "@/db/queries/desktop-user";
import { users } from "@/db/schema";
import { env } from "../env";

export const DESKTOP_USER_EMAIL = "local@openaudiohub.localhost";
export const DESKTOP_USER_NAME = "Local user";

/**
 * Returns the id of the account the desktop app signs in as.
 *
 * With OAH_DESKTOP_USER_ID set, that account must exist. Otherwise the earliest
 * created user is used, and a fresh account with no credentials is created when
 * the table is empty. The lock covers the check and the create, so concurrent
 * exchanges cannot produce two accounts.
 */
export async function resolveDesktopUserId(
    createLocalUser: () => Promise<{ id: string }>,
): Promise<string> {
    return db.transaction(async (tx) => {
        await acquireDesktopUserLock(tx);

        if (env.OAH_DESKTOP_USER_ID) {
            const [bound] = await tx
                .select({ id: users.id })
                .from(users)
                .where(eq(users.id, env.OAH_DESKTOP_USER_ID))
                .limit(1);
            if (!bound) {
                throw new Error(
                    "OAH_DESKTOP_USER_ID does not match a user in the database",
                );
            }
            return bound.id;
        }

        const [earliest] = await tx
            .select({ id: users.id })
            .from(users)
            .orderBy(asc(users.createdAt))
            .limit(1);
        if (earliest) {
            return earliest.id;
        }

        const created = await createLocalUser();
        return created.id;
    });
}
