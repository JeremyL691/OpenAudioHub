import type { MetadataRoute } from "next";

// Self-host instances are not crawled (see `robots.ts`), so they expose no
// sitemap entries.
export default function sitemap(): MetadataRoute.Sitemap {
    return [];
}
