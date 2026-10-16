import type { Recording } from "@/types/recording";

/** Smart collections shown in the sidebar and selected with `/recordings?collection=<id>`. */
export const COLLECTIONS = [
    { id: "starred", label: "Starred" },
    { id: "recent", label: "Last 7 days" },
    { id: "plaud", label: "From Plaud" },
    { id: "uploaded", label: "Uploaded" },
] as const;

export type CollectionId = (typeof COLLECTIONS)[number]["id"];

export type CollectionCounts = Record<CollectionId | "all", number>;

/** Uploads and merges are stored with this device serial. */
export const LOCAL_DEVICE_SN = "local";

export const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function isCollectionId(value: unknown): value is CollectionId {
    return COLLECTIONS.some((collection) => collection.id === value);
}

export function collectionLabel(id: CollectionId): string {
    return COLLECTIONS.find((collection) => collection.id === id)?.label ?? id;
}

/** Whether a recording belongs to a collection. Mirrors `getCollectionCounts`. */
export function inCollection(
    recording: Pick<Recording, "starred" | "startTime" | "deviceSn">,
    id: CollectionId,
    now: number = Date.now(),
): boolean {
    switch (id) {
        case "starred":
            return recording.starred === true;
        case "recent":
            return now - Date.parse(recording.startTime) <= RECENT_WINDOW_MS;
        case "uploaded":
            return recording.deviceSn === LOCAL_DEVICE_SN;
        case "plaud":
            return recording.deviceSn !== LOCAL_DEVICE_SN;
    }
}
