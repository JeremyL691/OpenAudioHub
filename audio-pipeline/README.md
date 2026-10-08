# OpenAudioHub Audio Preprocessing Pipeline

Private, model-independent service for long Plaud recordings. OpenAudioHub Core keeps provider credentials and storage access. This service receives only a short-lived job identity, and it calls authenticated Core bridge endpoints.

The service decodes to disk-backed mono 16 kHz PCM, runs the pinned Silero ONNX model, makes continuous non-overlapping chunks, and restores provider segment timestamps to absolute source milliseconds. It keeps task and chunk state in SQLite WAL under `/data`, and successful intermediate chunk results are reused after a restart. Working audio is removed only after Core acknowledges a persisted result. Chunk plans can keep up to 50 ms of adjacent source audio after a speech run as timestamp-rounding context. That audio is real source audio inside the chunk bounds, not timestamp clamping, and it never joins separate speech runs across the configured long-silence threshold.

Run it locally with `uvicorn audio_pipeline.app:app --host 0.0.0.0 --port 8100`. The API is protected by a bearer token. `/health` is the only unauthenticated route.

See [docs/audio-pipeline.md](../docs/audio-pipeline.md) for enablement, operations, and the processing contract.
