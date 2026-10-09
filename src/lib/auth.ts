import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { isDesktopMode } from "./desktop/mode";
import { desktopSessionPlugin } from "./desktop/session-plugin";
import { env } from "./env";
import { sendPasswordResetEmail } from "./notifications/email";

const EMAIL_VERIFICATION_TTL_SECONDS = 24 * 60 * 60;

export const auth = betterAuth({
    database: drizzleAdapter(db, {
        provider: "pg",
        schema,
        usePlural: true,
    }),
    emailAndPassword: {
        enabled: true,
        requireEmailVerification: false,
        disableSignUp: env.DISABLE_REGISTRATION,
        sendResetPassword: async ({ user, url }) => {
            await sendPasswordResetEmail(user.email, url);
        },
        resetPasswordTokenExpiresIn: 60 * 60,
        revokeSessionsOnPasswordReset: true,
    },
    emailVerification: {
        // Verification is never enforced, so no verification email is sent.
        sendVerificationEmail: async () => {},
        sendOnSignUp: false,
        autoSignInAfterVerification: true,
        expiresIn: EMAIL_VERIFICATION_TTL_SECONDS,
    },
    user: {
        changeEmail: {
            enabled: true,
            // Confirmation emails are never sent on self-host (see emailVerification).
            sendChangeEmailConfirmation: async () => {},
        },
    },
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.APP_URL,
    plugins: isDesktopMode() ? [desktopSessionPlugin()] : [],
});

export type Session = typeof auth.$Infer.Session;
