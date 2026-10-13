import type { Readable } from "node:stream";
import type { StorageProvider } from "@/lib/storage/types";
import { streamMp3ForDownload } from "@/lib/transcription/ffmpeg";
import { audioExtension } from "./filename";

/** The recording's audio as an MP3 stream; MP3 sources pass through untouched. */
export async function openAudioAsMp3(
    storage: StorageProvider,
    storagePath: string,
): Promise<Readable> {
    const audio = await storage.downloadStream(storagePath);
    return audioExtension(storagePath) === "mp3"
        ? audio
        : streamMp3ForDownload(audio);
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
