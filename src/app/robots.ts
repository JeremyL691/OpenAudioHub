import type { MetadataRoute } from "next";

// Self-host instances are private by default: block all crawling.
export default function robots(): MetadataRoute.Robots {
    return {
        rules: [{ userAgent: "*", disallow: "/" }],
    };
}
