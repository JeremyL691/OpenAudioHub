# Audio preprocessing pipeline

The audio pipeline is an optional, private service that prepares long recordings before server-side speech recognition. Plaud sync and the stored source audio are unchanged. The player keeps using the original audio.

## Enablement

The bundled Compose file enables the pipeline (`AUDIO_PIPELINE_ENABLED=true`). The application itself defaults to off, so a deployment that does not use the bundled Compose file must set `AUDIO_PIPELINE_ENABLED=true` explicitly.

Both services read `AUDIO_PIPELINE_TOKEN`, a shared secret of at least 32 characters. Compose requires the variable even when the pipeline is disabled, so set it in every installation.

For a fresh installation, copy `.env.example` to `.env`, then set separate random values for `POSTGRES_PASSWORD`, `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, and `AUDIO_PIPELINE_TOKEN`. `openssl rand -hex 32` produces a suitable value. Set `APP_URL` to the address you use.

To turn processing off, set `AUDIO_PIPELINE_ENABLED=false` in `.env` and start the stack again. New transcriptions then use the regular path. Browser transcription is unchanged, and existing transcripts are not reprocessed.

The pipeline API is reachable only on the Compose network. Its SQLite database and temporary workspace are stored in the `audio-pipeline-data` volume.

## Resource budget

The service runs one recording job at a time, with two concurrent STT requests, two CPUs, and 2 GiB of memory. A 24-hour recording needs about 2.76 GB for decoded PCM, in addition to the source audio and temporary files. A job pauses with a disk-space error when that space is not available, and it resumes automatically once space is free.

## Providers and job controls

Select a server provider in OpenAudioHub's settings before you request transcription. The pipeline uses the existing provider configuration for OpenAI-style and chat-style requests, and for Gemini. Timestamp support depends on the selected model and on what its response contains. Gemini and chat-style requests currently provide text only.

The ElevenLabs path reuses Core's existing Scribe client for each audio chunk. Core keeps the API key, applies the stored base-URL policy and request timeout, and sends only the returned text and word timings to the private pipeline. New jobs record the diarization setting and the optional speaker-count hint when they start. Older jobs without those fields use the upstream diarization default and no speaker-count hint. Speaker IDs are scoped to their source chunk, so `speaker_0` in two chunks does not mean the same person spoke in both.

The dashboard shows the current processing phase and progress. Cancel stops the task. Retry requeues failed work, and completed chunk results are kept. A service restart resumes from the durable job store and the VAD checkpoint files. A disk-space pause is retried automatically. These are implemented recovery paths. They do not guarantee that a provider never receives a duplicate, billable request after a network interruption.

## Limits

- The pipeline accepts recordings up to 24 hours. That limit is enforced in code. A 24-hour endurance run has not been performed.
- Timestamp positioning requires valid segment timestamps from the selected model. The ElevenLabs path returns word timings. Gemini and chat-style transcription save text without a timeline.
- Accuracy, latency, and provider cost have not been measured against real recordings or compared with the regular path. VAD and chunking add their own processing time.
- The ElevenLabs path has been tested with controlled responses and local mocks, without a billable request. Behavior with the live service can differ.

## Data and upgrades

Original recordings stay in the configured storage. The `audio-pipeline-data` volume contains SQLite state, temporary source audio, decoded PCM, checkpoints, and intermediate chunk results. Treat this volume as sensitive data. It is separate from Core's encrypted database. Temporary audio is removed after Core acknowledges a persisted result, or after a cancellation is finalized. Never commit a copy of this volume.

Back up Core's database, its encryption key, the recording storage, and the pipeline volume before an upgrade. A Postgres dump and a storage snapshot form the operations-recovery set. The user's full-data ZIP is a portable export, not a server restore package. The encryption key is required to recover encrypted content, and it must be stored apart from the database backup. See the [operations backup, restore, and verification runbook](audio-pipeline-operations.md). Do not use volume-deleting Compose commands as an ordinary restart.

Upgrade the pipeline before Core when a release changes the pipeline's job fields. OpenAudioHub 1.0.0 renames the legacy job field to `core_job_id`. A new pipeline still accepts requests from an older Core, but an older pipeline cannot serve a new Core. The [migration guide](MIGRATION_FROM_RIFFADO.md) gives the full order.

## Processing contract

The bundled Silero ONNX model is pinned by SHA-256, and the hash is checked before use. The pipeline decodes audio through FFmpeg to disk-backed 16 kHz mono PCM, detects speech, and creates continuous, non-overlapping chunks. Gaps longer than 1.5 seconds are omitted, and shorter pauses stay in the audio. Chunk boundaries prefer pauses near 120 seconds, and a chunk never exceeds 170 seconds. Each speech run can include up to 50 ms of the adjacent source audio at its end as timestamp-rounding context. That context does not bridge long pauses or change the chunk's absolute source offset.

Chunk times are integer sample positions in the original recording. Provider-native segment timestamps are validated before they are converted to absolute milliseconds. Whitespace-only segments are ignored for positioning, and the provider's full text is kept unchanged. An end time that overshoots the chunk by up to 50 ms, inclusive, is clamped to the actual chunk end. The original end, the corrected end, the chunk index, and the reason are recorded on the segment. Those timelines use the source `normalized`. Unchanged provider timestamps use `native`. Larger overshoots, invalid numbers, negative or unordered starts, zero-length results after correction, and text without usable timestamps are marked `needs_alignment`. In that case no positions are invented. Search and summaries always use the full transcript text.

Full-data ZIP exports keep `schema_version: 1` and include `timeline.json`. It records the timestamp source, the processing configuration, the speaker IDs and chunk indexes, and the correction for each segment. Timelines created before these optional fields were added remain readable.

The offline repair command can preview acknowledged alignment jobs and write a private, hash-bound plan. Run it inside the pipeline container, and check its counts before you apply the plan:

```sh
docker compose exec audio-pipeline python -m audio_pipeline.repair \
  --preview-output /data/repairs/timeline-repair.json
docker compose exec audio-pipeline python -m audio_pipeline.repair \
  --apply /data/repairs/timeline-repair.json
```

The plan contains plaintext transcript material. Keep it in the private pipeline data volume, or in another location with restricted access. After it is applied, the plan is replaced with a receipt. Applying a plan checks the current transcript hash and the latest task generation, and it refuses deleted recordings and active jobs. Repair never calls a transcription provider and never regenerates summaries.

The service exposes authenticated endpoints for job submit, status, result, retry, cancel, and acknowledge under `/v1/jobs`. The only unauthenticated endpoint is `/health`, which the container health check uses.
