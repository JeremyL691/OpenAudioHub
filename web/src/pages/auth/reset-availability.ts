import { usePublicConfig, usePublicConfigState } from "@/lib/public-config";

/** Whether this instance can email password reset links, that is, whether the server has SMTP configured. */
export function usePasswordResetByEmail(): boolean | null {
    const config = usePublicConfig();
    return config ? config.passwordResetEnabled : null;
}

/** Like usePasswordResetByEmail, plus the load error and a retry for when the server could not be asked. */
export function usePasswordResetAvailability(): { byEmail: boolean | null; error: Error | null; retry: () => void } {
    const { config, error, retry } = usePublicConfigState();
    return { byEmail: config ? config.passwordResetEnabled : null, error, retry };
}
