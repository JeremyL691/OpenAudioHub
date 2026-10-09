export interface ImportedUser {
    id: string;
    email: string;
    createdAt: Date;
}

/**
 * Chooses the account the App signs in as (PLAN T15.2 step 8). One user is bound automatically. With several users,
 * --user-email names the account; without it the import stops and says what to pass. Email matching ignores case.
 */
export function chooseUser(
    users: ImportedUser[],
    email?: string,
): ImportedUser {
    if (users.length === 0) throw new Error("the export has no user account");
    if (email) {
        const wanted = email.trim().toLowerCase();
        const match = users.find((user) => user.email.toLowerCase() === wanted);
        if (!match)
            throw new Error(`no user with the email ${email} in the export`);
        return match;
    }
    if (users.length === 1) return users[0];
    throw new Error(
        `the export has ${users.length} users; pass --user-email with the account to sign in as`,
    );
}
