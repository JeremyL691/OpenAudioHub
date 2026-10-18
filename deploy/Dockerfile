# OpenAudioHub server: one process, SQLite in /data. Build from the repository root:
#   docker build -f deploy/Dockerfile -t openaudiohub .
FROM node:22-trixie-slim AS web
WORKDIR /src/web
RUN corepack enable
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm build

# trixie: the bundled ONNX Runtime needs the libstdc++ of GCC 14.
FROM rust:1-trixie AS server
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates/ crates/
# The workspace lists the desktop app; only its manifest is needed here, so the lock file stays valid.
COPY desktop-tauri/Cargo.toml desktop-tauri/Cargo.toml
RUN mkdir -p desktop-tauri/src && echo 'fn main() {}' > desktop-tauri/src/main.rs
COPY --from=web /src/web/dist web/dist
RUN cargo build --release --locked -p oah --bin oah-server

FROM debian:trixie-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --home-dir /data oah \
    && mkdir -p /data && chown oah /data
COPY --from=server /src/target/release/oah-server /usr/local/bin/oah-server
USER oah
ENV OAH_DATA_DIR=/data HOST=0.0.0.0 PORT=3000
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1
ENTRYPOINT ["oah-server"]
