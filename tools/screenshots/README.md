# Screenshots

Regenerate the README images in `docs/images/` from demo data only:
`tools/screenshots/run.sh` (builds the server and web app, starts a throwaway server on port 3290 with its own data folder, seeds six demo recordings, captures four 1440x900 @2x pages, then stops everything it started).
Override ports with `SCREENSHOT_PORT` and `SCREENSHOT_FAKE_PORT`; set `CARGO_TARGET_DIR` to reuse a build directory.
Edit demo content in `demo-data.mjs`; `capture.mjs` seeds and captures, and `demo-ai.mjs` serves the local demo responses.
