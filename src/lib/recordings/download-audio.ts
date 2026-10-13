import type { StorageProvider } from "@/lib/storage/types";
import { transcodeToMp3ForDownload } from "@/lib/transcription/ffmpeg";
import { audioExtension } from "./filename";

/** The recording's audio as MP3 bytes; MP3 sources pass through untouched. */
export async function loadAudioAsMp3(
    storage: StorageProvider,
    storagePath: string,
): Promise<Buffer> {
    const audio = await storage.downloadFile(storagePath);
    return audioExtension(storagePath) === "mp3"
        ? audio
        : transcodeToMp3ForDownload(audio);
}

/** Name unique within one archive: "a.mp3", "a (2).mp3", ... */
export function uniqueArchiveName(name: string, used: Set<string>): string {
    const dot = name.lastIndexOf(".");
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    let candidate = name;
    for (let n = 2; used.has(candidate.toLowerCase()); n++) {
        candidate = `${base} (${n})${ext}`;
    }
    used.add(candidate.toLowerCase());
    return candidate;
}
