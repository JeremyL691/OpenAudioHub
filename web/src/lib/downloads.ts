import { toast } from "sonner";
import { errorMessage } from "./api";

export type DownloadFormat = "mp3" | "original";

interface DesktopDownloads {
    downloadRecordings?: (ids: string[], format: DownloadFormat) => Promise<string | null>;
}

function bridge(): DesktopDownloads | null {
    return (window as unknown as { __openaudiohubDesktop?: DesktopDownloads }).__openaudiohubDesktop ?? null;
}

/** True when the desktop app shows the save dialog and writes the file itself. */
export function savesNatively(): boolean {
    return typeof bridge()?.downloadRecordings === "function";
}

/** A bridge rejection arrives as plain text; a server answer as an ApiError. */
function messageOf(err: unknown, fallback: string): string {
    return typeof err === "string" && err.trim() ? err : errorMessage(err, fallback);
}

let running = false;

/**
 * Saves one recording's audio, or one archive of several. The desktop app asks where to save
 * and writes the file itself. The browser downloads through the server address as before.
 */
export async function downloadRecordings(ids: string[], format: DownloadFormat = "mp3"): Promise<boolean> {
    if (ids.length === 0) return false;
    if (running) {
        toast.error("A download is already in progress");
        return false;
    }
    running = true;
    try {
        const desktop = bridge();
        if (desktop?.downloadRecordings) {
            const saved = await desktop.downloadRecordings(ids, format);
            if (saved) toast.success(ids.length === 1 ? "Audio saved" : "Archive saved");
            return Boolean(saved);
        }
        const url =
            ids.length === 1 && format === "mp3"
                ? `/api/recordings/${encodeURIComponent(ids[0])}/audio?download=1`
                : `/api/recordings/download?ids=${ids.map(encodeURIComponent).join(",")}&format=${format}`;
        const link = document.createElement("a");
        link.href = url;
        link.download = "";
        document.body.appendChild(link);
        link.click();
        link.remove();
        return true;
    } catch (err) {
        toast.error(messageOf(err, "Could not save the download"));
        return false;
    } finally {
        running = false;
    }
}
