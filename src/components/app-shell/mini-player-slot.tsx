"use client";

import { createContext, type ReactNode, useContext, useState } from "react";

const MiniPlayerSlotContext = createContext<HTMLElement | null>(null);

/**
 * Wraps the page content and places a sticky anchor directly under the top bar.
 * The compact player portals into the anchor. The anchor takes no space in the
 * flow, so showing the bar never moves the page, and it stays inside the content
 * column beside the sidebar.
 */
export function MiniPlayerHost({ children }: { children: ReactNode }) {
    const [slot, setSlot] = useState<HTMLDivElement | null>(null);
    return (
        <MiniPlayerSlotContext.Provider value={slot}>
            <div ref={setSlot} className="sticky top-14 z-30 h-0" />
            {children}
        </MiniPlayerSlotContext.Provider>
    );
}

/** The anchor the compact player renders into, or null outside the app shell. */
export function useMiniPlayerSlot(): HTMLElement | null {
    return useContext(MiniPlayerSlotContext);
}
