import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
    return {
        name: "OpenAudioHub",
        short_name: "OpenAudioHub",
        description:
            "Open-source AI transcription for the voice recorder you already own.",
        start_url: "/",
        display: "standalone",
        background_color: "#f3f7fc",
        theme_color: "#f3f7fc",
        icons: [
            {
                src: "/icon-192.png",
                sizes: "192x192",
                type: "image/png",
                purpose: "any",
            },
            {
                src: "/icon-512.png",
                sizes: "512x512",
                type: "image/png",
                purpose: "any",
            },
        ],
    };
}
