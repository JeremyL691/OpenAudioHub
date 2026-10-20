# Check scripts

Small checks that run over declarations and scripts rather than over the product. CI runs each
of them, and each one can be run on its own.

| Script | What it checks |
|---|---|
| `rust-version.sh` | The Rust version is declared the same way in the workspace, the toolchain pin, the workflow and container images, and the documents a reader installs from. |
| `fetch-source.sh` | The download helper used by the Mac app build, against a local server: a good download, a cache hit, wrong bytes, a server error, a stalled host, an unreachable host, a tampered cache and a digest that cannot match. |

They print what they found and exit non-zero on a failure, so a failing check can be read in a CI
log without opening the script.
