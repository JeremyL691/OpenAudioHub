"use client";

import { createContext, useContext } from "react";

const DesktopModeContext = createContext(false);

/**
 * Passes whether the page runs inside the macOS desktop shell (OAH_DESKTOP=1)
 * to client components. The root layout sets it from the server-side flag.
 */
export function DesktopModeProvider({
    value,
    children,
}: {
    value: boolean;
    children: React.ReactNode;
}) {
    return (
        <DesktopModeContext.Provider value={value}>
            {children}
        </DesktopModeContext.Provider>
    );
}

/** True inside the desktop shell. Outside it, every component renders as before. */
export function useDesktopMode(): boolean {
    return useContext(DesktopModeContext);
}
