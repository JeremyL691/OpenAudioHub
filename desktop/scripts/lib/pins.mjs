// Upstream artifacts used by the desktop build. Every download is checked against the sha256 below
// before it is used (PLAN §18 item 7). A new version needs a new pin and a DECISIONS entry.
export const PINS = Object.freeze({
    electron: {
        version: "44.7.0",
        // Fetched by the electron npm package's install.js; checksums.json inside the package carries this value.
        file: "electron-v44.7.0-darwin-arm64.zip",
        sha256: "e04e411b58a0a14375dd21b0ab4a378fd38930a702e4e20e322fee4849404c0b",
    },
    postgres: {
        version: "16.15-1",
        file: "postgresql-16.15-1-osx-binaries.zip",
        url: "https://get.enterprisedb.com/postgresql/postgresql-16.15-1-osx-binaries.zip",
        sha256: "a976e52512622cbae06145a86ff7a6c65e9a6559674d0dd55e45c26b56dbbac1",
        // Developer ID team of the signed upstream binaries, checked before thinning.
        teamId: "26QKX55P9K",
    },
    pythonStandalone: {
        version: "3.12.15",
        release: "20261003",
        file: "cpython-3.12.15+20261003-aarch64-apple-darwin-install_only_stripped.tar.gz",
        url: "https://github.com/astral-sh/python-build-standalone/releases/download/20261003/cpython-3.12.15%2B20261003-aarch64-apple-darwin-install_only_stripped.tar.gz",
        sha256: "ad8d0c637c0a36b967b310e2c07254f4d2ca8cabaa7699e55ed6290aceb481a2",
    },
    ffmpeg: {
        version: "9.0.2",
        file: "ffmpeg-9.0.2.tar.xz",
        url: "https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz",
        sha256: "8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e",
    },
    opus: {
        version: "1.6.1",
        file: "opus-1.6.1.tar.gz",
        url: "https://downloads.xiph.org/releases/opus/opus-1.6.1.tar.gz",
        sha256: "6ffcb593207be92584df15b32466ed64bbec99109f007c82205f0194572411a1",
    },
    lame: {
        version: "4.0",
        file: "lame-4.0.tar.gz",
        url: "https://downloads.sourceforge.net/project/lame/lame/4.0/lame-4.0.tar.gz",
        sha256: "3df5124d5ad3a98312ffd7ba6a9b36230e4f8a3e66d3ce0f425e336c32d216eb",
    },
});
