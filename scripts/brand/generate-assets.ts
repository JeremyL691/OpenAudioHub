// Derives the raster brand assets from the designer's PNG sources in brand/source/.
// Run with: node scripts/brand/generate-assets.ts
// Outputs are committed. Re-run after a source or public/brand/mark.svg changes.

import { copyFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const path = (...parts: string[]) => join(root, ...parts);

const sources = {
    mark: path("brand", "source", "mark.png"),
    appIcon: path("brand", "source", "app-icon.png"),
    heroBanner: path("brand", "source", "hero-banner.png"),
    horizontal: path("brand", "source", "horizontal-2.png"),
};

// Builds a multi-resolution ICO file from PNG images (Windows Vista format).
function buildIco(images: { size: number; data: Buffer }[]): Buffer {
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(images.length, 4);

    const directory = Buffer.alloc(16 * images.length);
    let offset = 6 + directory.length;
    images.forEach((image, index) => {
        const entry = index * 16;
        const dimension = image.size >= 256 ? 0 : image.size;
        directory.writeUInt8(dimension, entry);
        directory.writeUInt8(dimension, entry + 1);
        directory.writeUInt8(0, entry + 2);
        directory.writeUInt8(0, entry + 3);
        directory.writeUInt16LE(1, entry + 4);
        directory.writeUInt16LE(32, entry + 6);
        directory.writeUInt32LE(image.data.length, entry + 8);
        directory.writeUInt32LE(offset, entry + 12);
        offset += image.data.length;
    });

    return Buffer.concat([header, directory, ...images.map((i) => i.data)]);
}

async function square(source: string, size: number) {
    return sharp(source)
        .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer();
}

async function main() {
    // Next.js app icons. icon.svg is the vector mark. apple-icon.png is the
    // 180 px touch icon from the app icon card.
    copyFileSync(path("public", "brand", "mark.svg"), path("src", "app", "icon.svg"));
    writeFileSync(path("src", "app", "apple-icon.png"), await square(sources.appIcon, 180));

    // Favicon: the bare mark, transparent, so it reads on any browser chrome.
    const favicon = await Promise.all(
        [16, 32, 48].map(async (size) => ({ size, data: await square(sources.mark, size) })),
    );
    writeFileSync(path("src", "app", "favicon.ico"), buildIco(favicon));

    // Web app manifest icons.
    writeFileSync(path("public", "icon-192.png"), await square(sources.appIcon, 192));
    writeFileSync(path("public", "icon-512.png"), await square(sources.appIcon, 512));

    // Open Graph card, 1200 x 630, cropped from the hero banner.
    writeFileSync(
        path("public", "og.png"),
        await sharp(sources.heroBanner)
            .resize(1200, 630, { fit: "cover", position: "centre" })
            .png()
            .toBuffer(),
    );

    // Email header logo. Trim the transparent margin, then store 360 px wide.
    writeFileSync(
        path("public", "brand", "email-logo.png"),
        await sharp(sources.horizontal)
            .trim()
            .resize({ width: 360 })
            .png()
            .toBuffer(),
    );

    // README hero, the full banner as designed.
    copyFileSync(sources.heroBanner, path("brand", "readme-hero.png"));

    console.log("brand assets written");
}

await main();
