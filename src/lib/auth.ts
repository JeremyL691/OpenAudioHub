import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { env } from "./env";
import {
    sendEmailChangeConfirm,
    sendPasswordResetEmail,
    sendVerifyEmail,
} from "./notifications/email";
import { isSmtpConfigured } from "./smtp";

const EMAIL_VERIFICATION_TTL_SECONDS = 24 * 60 * 60;

/**
 * Email verification is enforced only on the hosted instance (and only
 * when SMTP is actually configured there -- no delivery channel for the
 * link otherwise). Self-host instances never enforce verification, even
 * when they configure SMTP for notification emails: `IS_HOSTED` is the
 * rollout boundary from `scripts/billing-backfill.ts`, which grandfathers
 * every pre-launch row to `emailVerified=true` -- that's a one-shot ops
 * script run once against the hosted DB at launch, not something
 * self-host operators ever run. Gating on `isSmtpConfigured()` alone
 * would flip verification on for any self-host deployment that has SMTP
 * configured and immediately lock out its existing unverified accounts.
 */
const verificationActive = env.IS_HOSTED && isSmtpConfigured();

/**
 * Public alias for `verificationActive`, for callers outside this module
 * (e.g. the register page/form) that need to know whether sign-up leaves
 * the user unauthenticated pending email verification. Single source of
 * truth -- don't re-derive the `IS_HOSTED && isSmtpConfigured()` condition
 * elsewhere.
 */
export const emailVerificationRequired = verificationActive;

export const auth = betterAuth({
    database: drizzleAdapter(db, {
        provider: "pg",
        schema,
        usePlural: true,
    }),
    emailAndPassword: {
        enabled: true,
        requireEmailVerification: verificationActive,
        disableSignUp: env.DISABLE_REGISTRATION,
        sendResetPassword: async ({ user, url }) => {
            await sendPasswordResetEmail(user.email, url);
        },
        resetPasswordTokenExpiresIn: 60 * 60,
        revokeSessionsOnPasswordReset: true,
    },
    emailVerification: {
        sendVerificationEmail: async ({ user, url }) => {
            if (!verificationActive) return;
            await sendVerifyEmail({
                email: user.email,
                verificationUrl: url,
                expiresInSeconds: EMAIL_VERIFICATION_TTL_SECONDS,
            });
        },
        sendOnSignUp: verificationActive,
        autoSignInAfterVerification: true,
        expiresIn: EMAIL_VERIFICATION_TTL_SECONDS,
    },
    user: {
        changeEmail: {
            enabled: true,
            sendChangeEmailConfirmation: async ({ user, newEmail, url }) => {
                if (!verificationActive) return;
                await sendEmailChangeConfirm({
                    sendTo: user.email,
                    newEmail,
                    confirmUrl: url,
                    expiresInSeconds: EMAIL_VERIFICATION_TTL_SECONDS,
                });
            },
        },
    },
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.APP_URL,
});

export type Session = typeof auth.$Infer.Session;
