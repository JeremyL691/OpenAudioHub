//! Worker for `pipeline` jobs (spec sections 7 to 12): decode, speech detection, chunk plan,
//! chunk transcription with retries, merge, save. Every step can run again after a crash;
//! finished chunks are never sent again.

use std::io::{self, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use futures_util::{TryStreamExt, stream};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use tokio::io::{AsyncReadExt as _, AsyncSeekExt as _};
use tokio::process::Command;

use super::{merge, plan, vad};
use crate::AppState;
use crate::ai::{self, Provider};
use crate::jobs::{self, Job, Outcome};
use crate::routes::recordings::media;
use crate::transcribe::{self, Options, Saved};

/// Chunk sends that run at once (stt_concurrency).
const STT_CONCURRENCY: usize = 2;
/// Tries per chunk before it fails.
const CHUNK_ATTEMPTS: u32 = 6;
/// The provider's per-chunk limits (170 s and 50 MIB).
const MAX_CHUNK_SAMPLES: u64 = 2_720_000;
const MAX_WAV_BYTES: usize = 50 * 1024 * 1024;
const MAX_DURATION_MS: i64 = 86_400_000;
const MAX_DECODED_SAMPLES: u64 = 1_382_400_320;
const MIB: u64 = 1024 * 1024;
/// Free space needed on top of the PCM for decoding.
const DECODE_RESERVE: u64 = 64 * MIB;
/// Free space a paused job waits for before it resumes (spec section 7.2).
const RESUME_RESERVE: u64 = 512 * MIB;
/// Speech detection checkpoint, next to the job's other files.
const VAD_CHECKPOINT: &str = "vad-checkpoint.bin";
const WAIT_DECODE: &str = "Waiting for disk space to decode the source audio";
const WAIT_FINISH_DECODE: &str = "Waiting for disk space to finish decoding audio";
const ERROR_CHARS: usize = 1000;

/// Free space a decode needs to start: the PCM plus the decode reserve.
fn decode_budget(pcm_bytes: u64) -> u64 {
    pcm_bytes + DECODE_RESERVE
}

/// Free space a paused decode needs to resume. The PCM counts only while it is not on disk yet.
fn resume_budget(pcm_bytes: u64, pcm_exists: bool) -> u64 {
    let pcm = if pcm_exists { 0 } else { pcm_bytes };
    pcm + RESUME_RESERVE
}

/// Why a step stopped the job early.
pub enum Stop {
    /// Terminal failure with the stored error type and message.
    Fail { code: &'static str, message: String },
    /// The job was cancelled; its files are removed.
    Cancelled,
    /// Transient failure; the job runs again later.
    Retry(String),
    /// Another worker took the job over, so this run stops without recording anything.
    LeaseLost,
}

type Step<T> = Result<T, Stop>;

/// Stops the run when a lease-guarded write wrote nothing, which means the lease was lost.
fn guard(wrote: bool) -> Step<()> {
    if wrote { Ok(()) } else { Err(Stop::LeaseLost) }
}

impl From<sqlx::Error> for Stop {
    fn from(e: sqlx::Error) -> Self {
        Stop::Retry(e.to_string())
    }
}

impl From<io::Error> for Stop {
    fn from(e: io::Error) -> Self {
        Stop::Retry(e.to_string())
    }
}

/// Options the transcription module passed in the job payload.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Payload {
    provider_id: Option<String>,
    model: Option<String>,
    language: Option<String>,
}

/// Work directory of one job: decoded PCM, speech probabilities, and temporary chunk files.
pub fn pipeline_dir(state: &AppState, job_id: &str) -> PathBuf {
    state.config.storage_root.join(".pipeline").join(job_id)
}

/// Marks the job cancelled unless it already reached a final phase. Returns false when the job
/// finished first, so the caller can tell the user the cancel came too late.
pub(super) async fn cancel(db: &SqlitePool, job_id: &str) -> Result<bool, sqlx::Error> {
    let res = sqlx::query(
        "INSERT INTO pipeline_runs (job_id, phase, updated_at) VALUES (?, 'cancelled', ?)
         ON CONFLICT (job_id) DO UPDATE SET phase = 'cancelled', updated_at = excluded.updated_at
         WHERE pipeline_runs.phase NOT IN ('cancelled', 'completed', 'needs_alignment', 'failed')",
    )
    .bind(job_id)
    .bind(crate::db::now_ms())
    .execute(db)
    .await?;
    Ok(res.rows_affected() == 1)
}

/// Sets the phase shown to users. A cancelled job keeps its phase. A worker that lost its lease
/// writes nothing, so the run that replaced it keeps its own phase.
pub(super) async fn set_phase(
    db: &SqlitePool,
    lease: &Lease,
    phase: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO pipeline_runs (job_id, phase, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (job_id) DO UPDATE SET phase = excluded.phase, updated_at = excluded.updated_at
         WHERE pipeline_runs.phase <> 'cancelled'
           AND EXISTS (SELECT 1 FROM jobs WHERE id = ? AND state = 'running' AND lease_gen = ?)",
    )
    .bind(&lease.id)
    .bind(phase)
    .bind(crate::db::now_ms())
    .bind(&lease.id)
    .bind(lease.lease_gen)
    .execute(db)
    .await?;
    Ok(())
}

/// The claim this worker holds: the job id plus the generation that identifies the claim.
pub(super) struct Lease {
    pub id: String,
    pub lease_gen: i64,
}

impl Lease {
    fn of(job: &Job) -> Self {
        Self {
            id: job.id.clone(),
            lease_gen: job.lease_gen,
        }
    }
}

async fn is_cancelled(db: &SqlitePool, job_id: &str) -> Result<bool, sqlx::Error> {
    let phase: Option<String> =
        sqlx::query_scalar("SELECT phase FROM pipeline_runs WHERE job_id = ?")
            .bind(job_id)
            .fetch_optional(db)
            .await?;
    Ok(phase.as_deref() == Some("cancelled"))
}

async fn check_cancel(db: &SqlitePool, job_id: &str) -> Step<()> {
    if is_cancelled(db, job_id).await? {
        Err(Stop::Cancelled)
    } else {
        Ok(())
    }
}

/// Runs one pipeline job and turns the outcome into the queue's result.
pub async fn run(state: AppState, job: Job) -> Outcome {
    match process(&state, &job).await {
        Ok(()) => Outcome::Done,
        Err(Stop::Cancelled) => {
            let _ = tokio::fs::remove_dir_all(pipeline_dir(&state, &job.id)).await;
            Outcome::Done
        }
        Err(Stop::Fail { code, message }) => {
            let _ = set_phase(&state.db, &Lease::of(&job), "failed").await;
            if let (Some(user), Some(recording)) =
                (job.user_id.as_deref(), job.recording_id.as_deref())
            {
                crate::webhooks::emit_soft(
                    &state,
                    user,
                    recording,
                    "transcription.failed",
                    Some(&message),
                )
                .await;
            }
            Outcome::Failed {
                code,
                message: truncate(message),
            }
        }
        Err(Stop::LeaseLost) => {
            // The renewer notices the lost lease too; nothing is written either way.
            Outcome::Done
        }
        Err(Stop::Retry(message)) => Outcome::Retry {
            code: "PIPELINE_RETRY",
            message: truncate(message),
            after: jobs::backoff(job.attempts),
        },
    }
}

/// Options of one pipeline run: the stored model and language, and the speaker settings read
/// when the job runs, the same way the synchronous path reads them (spec section 3.3).
async fn run_options(
    state: &AppState,
    user_id: &str,
    filename: String,
    model: String,
    language: Option<String>,
) -> Step<Options> {
    let (diarize, speaker_count) = transcribe::speaker_settings(state, user_id)
        .await
        .map_err(|e| Stop::Retry(e.message))?;
    Ok(Options {
        filename,
        model,
        language,
        diarize,
        speaker_count,
    })
}

fn truncate(text: String) -> String {
    text.chars().take(ERROR_CHARS).collect()
}

async fn process(state: &AppState, job: &Job) -> Step<()> {
    let db = &state.db;
    let lease = Lease::of(job);
    let id = job.id.as_str();
    set_phase(db, &lease, "queued").await?;
    check_cancel(db, id).await?;

    let payload: Payload = serde_json::from_value(job.payload()).unwrap_or_default();
    let (Some(user_id), Some(recording_id)) = (job.user_id.as_deref(), job.recording_id.as_deref())
    else {
        return Err(Stop::Fail {
            code: "INTERNAL_ERROR",
            message: "Pipeline job has no recording".into(),
        });
    };
    let row: Option<(String, String, i64, String)> = sqlx::query_as(
        "SELECT storage_type, storage_path, duration, filename FROM recordings WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
    )
    .bind(recording_id)
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    let Some((storage_type, storage_path, duration_ms, filename)) = row else {
        return Err(Stop::Fail {
            code: "RECORDING_NOT_FOUND",
            message: "Recording is missing or deleted".into(),
        });
    };
    // The pipeline reads a local file. Object-storage audio is fetched for this run.
    let source = match state
        .storage
        .materialize(&storage_type, &storage_path)
        .await
    {
        Ok(source) => source,
        Err(crate::storage::StorageError::NotFound) => {
            return Err(Stop::Fail {
                code: "FileNotFoundError",
                message: "Audio file is missing".into(),
            });
        }
        Err(e) => {
            return Err(Stop::Fail {
                code: "STORAGE_ERROR",
                message: e.to_string(),
            });
        }
    };
    let audio = source.path().to_path_buf();
    // The stored provider is used while it exists. A deleted one (or a retry, which clears it)
    // resolves the current default again.
    let stored = match payload.provider_id.as_deref() {
        Some(id) => ai::transcription_provider(state, user_id, Some(id))
            .await
            .ok(),
        None => None,
    };
    let kept = stored.is_some();
    let provider = match stored {
        Some(provider) => provider,
        None => ai::transcription_provider(state, user_id, None)
            .await
            .map_err(|e| Stop::Fail {
                code: e.code,
                message: e.message,
            })?,
    };
    // A model name belongs to the provider it was chosen for.
    let model = match payload.model.clone() {
        Some(model) if kept => model,
        _ => provider.transcription_model(),
    };
    let filename = state
        .config
        .field_key
        .decrypt(&filename)
        .unwrap_or_else(|_| "recording".to_owned());
    let options = run_options(
        state,
        user_id,
        filename,
        model.clone(),
        payload.language.clone(),
    )
    .await?;

    // Duration limits (spec section 6.2).
    let probed = media::probe(&state.config.ffprobe, &audio)
        .await
        .map_or(0, |p| p.duration_ms);
    let duration_ms = duration_ms.max(probed);
    if duration_ms <= 0 {
        return Err(Stop::Fail {
            code: "AudioError",
            message: "Unable to determine source audio duration for disk budgeting".into(),
        });
    }
    if duration_ms > MAX_DURATION_MS {
        return Err(Stop::Fail {
            code: "LimitError",
            message: "Source audio exceeds the 24-hour pipeline limit".into(),
        });
    }

    let dir = pipeline_dir(state, id);
    tokio::fs::create_dir_all(&dir).await?;
    let pcm = dir.join("audio.pcm");
    if !pcm.exists() {
        let pcm_bytes = (duration_ms as u64 * 32_000).div_ceil(1000);
        decode_when_space(state, &lease, &audio, &dir, pcm_bytes).await?;
    }
    let samples = tokio::fs::metadata(&pcm).await?.len() / 2;
    if samples > MAX_DECODED_SAMPLES {
        return Err(Stop::Fail {
            code: "LimitError",
            message: "Decoded audio exceeds the 24-hour pipeline limit".into(),
        });
    }

    let probs = speech_probs(state, &lease, &dir, &pcm, samples).await?;
    let spans = plan::speech_spans(&probs, samples);
    create_plan(db, id, &pcm, &plan::plan_chunks(&spans, &probs, samples)).await?;

    set_phase(db, &lease, "transcribing").await?;
    guard(jobs::set_progress(db, id, lease.lease_gen, 0.68).await?)?;
    let ctx = Ctx {
        state,
        lease: &lease,
        provider: &provider,
        options: &options,
        pcm: &pcm,
        dir: &dir,
    };
    transcribe_chunks(&ctx).await?;

    let rows: Vec<(String, Option<String>)> =
        sqlx::query_as("SELECT state, response FROM pipeline_chunks WHERE job_id = ? ORDER BY idx")
            .bind(id)
            .fetch_all(db)
            .await?;
    if let Some((_, _)) = rows.iter().find(|(s, _)| s == "failed") {
        let message: String = sqlx::query_scalar(
            "SELECT error_message FROM pipeline_chunks WHERE job_id = ? AND state = 'failed' ORDER BY idx LIMIT 1",
        )
        .bind(id)
        .fetch_one(db)
        .await?;
        return Err(Stop::Fail {
            code: "ChunkFailed",
            message,
        });
    }
    let stored: Vec<merge::Stored> = rows
        .iter()
        .map(|(_, response)| {
            response
                .as_deref()
                .and_then(|r| serde_json::from_str(r).ok())
                .ok_or_else(|| Stop::Fail {
                    code: "ChunkFailed",
                    message: "Stored chunk result is unreadable".into(),
                })
        })
        .collect::<Step<_>>()?;
    let ranges: Vec<(i64, i64)> = sqlx::query_as(
        "SELECT start_sample, end_sample FROM pipeline_chunks WHERE job_id = ? ORDER BY idx",
    )
    .bind(id)
    .fetch_all(db)
    .await?;
    let chunks: Vec<merge::ChunkIn> = stored
        .iter()
        .zip(&ranges)
        .enumerate()
        .map(|(index, (result, &(start, end)))| merge::ChunkIn {
            index,
            start_sample: start as u64,
            end_sample: end as u64,
            result,
        })
        .collect();
    let merged = merge::merge(&chunks);

    save_merged(
        state,
        &lease,
        user_id,
        recording_id,
        &provider.name,
        &model,
        &merged,
    )
    .await?;
    let _ = tokio::fs::remove_dir_all(&dir).await;
    Ok(())
}

/// Saves the merged result as the job's transcript. The terminal phase goes into the same
/// transaction as the transcript, and a cancel that committed first wins over the save
/// (spec section 13.1).
async fn save_merged(
    state: &AppState,
    lease: &Lease,
    user_id: &str,
    recording_id: &str,
    provider: &str,
    model: &str,
    merged: &merge::Merged,
) -> Step<()> {
    let timeline = match &merged.timestamp_source {
        Some(source) if !merged.timeline.is_empty() => {
            Some((Value::Array(merged.timeline.clone()), *source))
        }
        _ => None,
    };
    let phase = if merged.needs_alignment {
        "needs_alignment"
    } else {
        "completed"
    };
    match transcribe::save_transcript(
        state,
        Saved {
            user_id,
            recording_id,
            transcript: &merged.transcript,
            provider,
            model,
            transcription_type: "server",
            timeline,
            job: Some((&lease.id, lease.lease_gen, phase)),
        },
    )
    .await
    {
        Ok(()) => Ok(()),
        Err(e) if e.code == "JOB_CANCELLED" => Err(Stop::Cancelled),
        Err(e) if e.code == "JOB_LEASE_LOST" => Err(Stop::LeaseLost),
        Err(e) => Err(Stop::Retry(e.message)),
    }
}

/// Decodes the source to PCM once the disk budget allows it (spec section 7). A decode that
/// fails while space is short pauses the job instead of failing it.
async fn decode_when_space(
    state: &AppState,
    lease: &Lease,
    audio: &Path,
    dir: &Path,
    pcm_bytes: u64,
) -> Step<()> {
    let first = decode_budget(pcm_bytes);
    let resume = resume_budget(pcm_bytes, false);
    wait_for_space(state, lease, first, resume, WAIT_DECODE).await?;
    loop {
        set_phase(&state.db, lease, "decode").await?;
        guard(jobs::set_progress(&state.db, &lease.id, lease.lease_gen, 0.05).await?)?;
        match decode(&state.config.ffmpeg, audio, dir).await {
            Ok(()) => return Ok(()),
            Err(e) => {
                let free = fs4::available_space(&state.config.storage_root)?;
                if free >= first {
                    return Err(Stop::Fail {
                        code: "AudioError",
                        message: format!("ffmpeg decode failed: {e}"),
                    });
                }
                wait_for_space(state, lease, first, resume, WAIT_FINISH_DECODE).await?;
            }
        }
    }
}

/// Waits until `first` bytes are free on the data volume. Once the job has paused, it resumes
/// only when `resume` bytes are free. Shows `paused_disk` with `message` while it waits.
async fn wait_for_space(
    state: &AppState,
    lease: &Lease,
    first: u64,
    resume: u64,
    message: &str,
) -> Step<()> {
    let mut need = first;
    loop {
        check_cancel(&state.db, &lease.id).await?;
        let free = fs4::available_space(&state.config.storage_root)?;
        if free >= need {
            guard(
                sqlx::query(
                    "UPDATE jobs SET error_code = NULL, error_message = NULL
                     WHERE id = ? AND state = 'running' AND lease_gen = ?",
                )
                .bind(&lease.id)
                .bind(lease.lease_gen)
                .execute(&state.db)
                .await?
                .rows_affected()
                    == 1,
            )?;
            return Ok(());
        }
        need = resume;
        set_phase(&state.db, lease, "paused_disk").await?;
        guard(
            sqlx::query(
                "UPDATE jobs SET error_code = 'DiskBudgetError', error_message = ?
                 WHERE id = ? AND state = 'running' AND lease_gen = ?",
            )
            .bind(message)
            .bind(&lease.id)
            .bind(lease.lease_gen)
            .execute(&state.db)
            .await?
            .rows_affected()
                == 1,
        )?;
        // Re-check every 30 s, but notice a cancel within a second.
        for _ in 0..30 {
            tokio::time::sleep(Duration::from_secs(1)).await;
            check_cancel(&state.db, &lease.id).await?;
        }
    }
}

/// ffmpeg to 16 kHz mono s16le, written to a temporary name and renamed when complete.
async fn decode(ffmpeg: &Path, source: &Path, dir: &Path) -> Result<(), String> {
    let partial = dir.join("audio.pcm.partial");
    let out = Command::new(ffmpeg)
        .args(["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i"])
        .arg(source)
        .args([
            "-map",
            "0:a:0",
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            "-f",
            "s16le",
        ])
        .arg(&partial)
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        let _ = tokio::fs::remove_file(&partial).await;
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_owned());
    }
    tokio::fs::File::open(&partial)
        .await
        .map_err(|e| e.to_string())?
        .sync_all()
        .await
        .map_err(|e| e.to_string())?;
    tokio::fs::rename(&partial, dir.join("audio.pcm"))
        .await
        .map_err(|e| e.to_string())
}

/// Speech probabilities, from the saved file when it is complete, otherwise computed.
/// A checkpoint is saved after each block, so an interrupted run resumes at the last block.
async fn speech_probs(
    state: &AppState,
    lease: &Lease,
    dir: &Path,
    pcm: &Path,
    samples: u64,
) -> Step<Vec<u8>> {
    let marker = dir.join("vad.complete");
    let probs_path = dir.join("vad-probabilities.u8");
    let expected_frames = samples.div_ceil(512);
    if let (Ok(text), Ok(meta)) = (
        tokio::fs::read_to_string(&marker).await,
        tokio::fs::metadata(&probs_path).await,
    ) && text == samples.to_string()
        && meta.len() == expected_frames
    {
        return Ok(tokio::fs::read(&probs_path).await?);
    }

    set_phase(&state.db, lease, "vad").await?;
    guard(jobs::set_progress(&state.db, &lease.id, lease.lease_gen, 0.10).await?)?;
    let checkpoint_path = dir.join(VAD_CHECKPOINT);
    // A damaged or mismatched checkpoint is ignored, so the run starts from block 0.
    let resume = tokio::fs::read(&checkpoint_path)
        .await
        .ok()
        .and_then(|bytes| vad::decode_checkpoint(&bytes, samples as usize));
    let handle = tokio::runtime::Handle::current();
    let db = state.db.clone();
    let pid = lease.id.clone();
    let (progress_id, progress_gen) = (pid.clone(), lease.lease_gen);
    let pcm_path = pcm.to_owned();
    let ckpt_path = checkpoint_path.clone();
    let probs = tokio::task::spawn_blocking(move || -> Result<Option<Vec<u8>>, String> {
        use std::io::Read as _;
        let mut session = vad::load()?;
        let mut file = std::fs::File::open(&pcm_path).map_err(|e| e.to_string())?;
        let read = move |start: usize, count: usize| -> Result<Vec<f32>, String> {
            let mut bytes = vec![0u8; count * 2];
            file.seek(SeekFrom::Start(start as u64 * 2))
                .map_err(|e| e.to_string())?;
            let mut filled = 0;
            while filled < bytes.len() {
                let n = file.read(&mut bytes[filled..]).map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                filled += n;
            }
            Ok(bytes
                .as_chunks::<2>()
                .0
                .iter()
                .map(|b| i16::from_le_bytes(*b) as f32 / 32768.0)
                .collect())
        };
        let progress = move |fraction: f64, cp: &vad::Checkpoint| -> bool {
            // A failed checkpoint only costs time after a crash, so it is logged and the run goes on.
            let bytes = vad::encode_checkpoint(samples as usize, cp);
            if let Err(e) = write_atomic(&ckpt_path, &bytes) {
                tracing::warn!(job = %pid, error = %e, "could not save speech detection checkpoint");
            }
            handle.block_on(async {
                // A lost lease stops the detection instead of reporting progress for a run that
                // no longer exists.
                let held = jobs::set_progress(&db, &progress_id, progress_gen, 0.10 + 0.55 * fraction)
                    .await
                    .unwrap_or(false);
                held && !matches!(is_cancelled(&db, &pid).await, Ok(true))
            })
        };
        vad::speech_probs(&mut session, samples as usize, resume, read, progress)
    })
    .await
    .map_err(|e| Stop::Retry(e.to_string()))?
    .map_err(Stop::Retry)?;
    let Some(probs) = probs else {
        return Err(Stop::Cancelled);
    };

    write_atomic(&probs_path, &probs)?;
    write_atomic(&marker, samples.to_string().as_bytes())?;
    let _ = tokio::fs::remove_file(&checkpoint_path).await;
    Ok(probs)
}

/// Writes the chunk plan once. Later runs keep the stored positions.
async fn create_plan(db: &SqlitePool, job_id: &str, pcm: &Path, ranges: &[(u64, u64)]) -> Step<()> {
    let existing: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pipeline_chunks WHERE job_id = ?")
        .bind(job_id)
        .fetch_one(db)
        .await?;
    if existing > 0 {
        return Ok(());
    }
    let mut rows = Vec::with_capacity(ranges.len());
    for (index, &(start, end)) in ranges.iter().enumerate() {
        let pcm_bytes = read_pcm(pcm, start, end).await?;
        let digest = hex::encode(Sha256::digest(&pcm_bytes));
        let chunk_id = hex::encode(Sha256::digest(
            format!("{job_id}:{index}:{start}:{end}:{digest}").as_bytes(),
        ));
        rows.push((index, start, end, chunk_id[..24].to_owned()));
    }
    let mut tx = db.begin().await?;
    for (index, start, end, chunk_id) in rows {
        sqlx::query("INSERT INTO pipeline_chunks (job_id, idx, chunk_id, start_sample, end_sample) VALUES (?, ?, ?, ?, ?)")
            .bind(job_id)
            .bind(index as i64)
            .bind(chunk_id)
            .bind(start as i64)
            .bind(end as i64)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Everything a chunk send needs.
struct Ctx<'a> {
    state: &'a AppState,
    lease: &'a Lease,
    provider: &'a Provider,
    options: &'a Options,
    pcm: &'a Path,
    dir: &'a Path,
}

/// Sends every chunk that is not completed, two at a time.
async fn transcribe_chunks(ctx: &Ctx<'_>) -> Step<()> {
    let db = &ctx.state.db;
    let todo: Vec<(i64, i64, i64)> = sqlx::query_as(
        "SELECT idx, start_sample, end_sample FROM pipeline_chunks WHERE job_id = ? AND state <> 'completed' ORDER BY idx",
    )
    .bind(&ctx.lease.id)
    .fetch_all(db)
    .await?;
    let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pipeline_chunks WHERE job_id = ?")
        .bind(&ctx.lease.id)
        .fetch_one(db)
        .await?;
    stream::iter(todo.into_iter().map(Ok::<_, Stop>))
        .try_for_each_concurrent(STT_CONCURRENCY, |(index, start, end)| async move {
            transcribe_one(ctx, index, start as u64, end as u64).await?;
            let done: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM pipeline_chunks WHERE job_id = ? AND state = 'completed'",
            )
            .bind(&ctx.lease.id)
            .fetch_one(&ctx.state.db)
            .await?;
            let progress = 0.68 + 0.30 * done as f64 / total.max(1) as f64;
            guard(
                jobs::set_progress(&ctx.state.db, &ctx.lease.id, ctx.lease.lease_gen, progress)
                    .await?,
            )?;
            Ok(())
        })
        .await
}

/// Sends one chunk with retries. A chunk that still fails is recorded, not raised.
async fn transcribe_one(ctx: &Ctx<'_>, index: i64, start: u64, end: u64) -> Step<()> {
    let db = &ctx.state.db;
    check_cancel(db, &ctx.lease.id).await?;
    let samples = end - start;
    let pcm = read_pcm(ctx.pcm, start, end).await?;
    let wav = wav_bytes(&pcm);
    if samples > MAX_CHUNK_SAMPLES {
        return record_failure(
            db,
            &ctx.lease.id,
            index,
            "LimitError",
            "Chunk exceeds provider duration limit",
        )
        .await;
    }
    if wav.len() > MAX_WAV_BYTES {
        return record_failure(
            db,
            &ctx.lease.id,
            index,
            "LimitError",
            "Chunk exceeds provider file-size limit",
        )
        .await;
    }
    let wav_path = ctx.dir.join(format!("chunk-{index:05}.wav"));
    write_atomic(&wav_path, &wav)?;

    let mut attempt = 0;
    loop {
        attempt += 1;
        sqlx::query("UPDATE pipeline_chunks SET state = 'running', attempts = ? WHERE job_id = ? AND idx = ?")
            .bind(attempt)
            .bind(&ctx.lease.id)
            .bind(index)
            .execute(db)
            .await?;
        match transcribe::transcribe_file(ctx.state, ctx.provider, &wav_path, ctx.options).await {
            Ok(t) => {
                let response = serde_json::to_string(&merge::Stored {
                    text: t.text,
                    language: t.language,
                    segments: t.segments,
                })
                .map_err(|e| Stop::Retry(e.to_string()))?;
                sqlx::query("UPDATE pipeline_chunks SET state = 'completed', response = ?, error_code = NULL, error_message = NULL WHERE job_id = ? AND idx = ?")
                    .bind(response)
                    .bind(&ctx.lease.id)
                    .bind(index)
                    .execute(db)
                    .await?;
                break;
            }
            Err(e) if e.retryable && attempt < CHUNK_ATTEMPTS => {
                tokio::time::sleep(retry_delay(attempt)).await;
                check_cancel(db, &ctx.lease.id).await?;
            }
            Err(e) => {
                record_failure(db, &ctx.lease.id, index, e.code, &e.message).await?;
                break;
            }
        }
    }
    let _ = tokio::fs::remove_file(&wav_path).await;
    Ok(())
}

async fn record_failure(
    db: &SqlitePool,
    job_id: &str,
    index: i64,
    code: &str,
    message: &str,
) -> Step<()> {
    sqlx::query("UPDATE pipeline_chunks SET state = 'failed', error_code = ?, error_message = ? WHERE job_id = ? AND idx = ?")
        .bind(code)
        .bind(truncate(message.to_owned()))
        .bind(job_id)
        .bind(index)
        .execute(db)
        .await?;
    Ok(())
}

/// Exponential delay from 2 s, capped at 120 s, with up to 1 s of jitter (spec 8.5).
fn retry_delay(attempt: u32) -> Duration {
    let delay = (2.0 * 2f64.powi(attempt as i32 - 1)).min(120.0);
    let jitter = rand::random_range(0.0..=(0.2 * delay).min(1.0));
    Duration::from_secs_f64(delay + jitter)
}

/// Reads the PCM bytes of samples `start..end`.
async fn read_pcm(path: &Path, start: u64, end: u64) -> io::Result<Vec<u8>> {
    let mut file = tokio::fs::File::open(path).await?;
    file.seek(SeekFrom::Start(start * 2)).await?;
    let mut bytes = vec![0u8; ((end - start) * 2) as usize];
    file.read_exact(&mut bytes).await?;
    Ok(bytes)
}

/// A 16 kHz mono 16-bit WAV file around `pcm`.
fn wav_bytes(pcm: &[u8]) -> Vec<u8> {
    let len = pcm.len() as u32;
    let mut out = Vec::with_capacity(44 + pcm.len());
    out.extend_from_slice(b"RIFF");
    out.extend((36 + len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend(16u32.to_le_bytes());
    out.extend(1u16.to_le_bytes());
    out.extend(1u16.to_le_bytes());
    out.extend(16_000u32.to_le_bytes());
    out.extend(32_000u32.to_le_bytes());
    out.extend(2u16.to_le_bytes());
    out.extend(16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend(len.to_le_bytes());
    out.extend_from_slice(pcm);
    out
}

/// Writes through a temporary name, syncs, then renames, so a crash never leaves a partial file.
fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let tmp = path.with_file_name(format!("{name}.partial"));
    {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn run_options_read_the_speaker_settings_when_the_job_runs() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(
            crate::config::Config::for_tests(dir.path()),
            crate::db::open_memory().await.unwrap(),
        );
        sqlx::query(
            "INSERT INTO users (id, email, created_at, updated_at) VALUES ('u', 'u@x.test', 0, 0)",
        )
        .execute(&state.db)
        .await
        .unwrap();
        let defaults = run_options(&state, "u", "Fixture".into(), "whisper-1".into(), None)
            .await
            .ok()
            .unwrap();
        assert!(defaults.diarize);
        assert_eq!(defaults.speaker_count, None);
        sqlx::query("INSERT INTO user_settings (user_id, data, updated_at) VALUES ('u', ?, 0)")
            .bind(
                serde_json::json!({"speakerDiarization": false, "diarizationSpeakerCount": 4})
                    .to_string(),
            )
            .execute(&state.db)
            .await
            .unwrap();
        let stored = run_options(
            &state,
            "u",
            "Fixture".into(),
            "whisper-1".into(),
            Some("en".into()),
        )
        .await
        .ok()
        .unwrap();
        assert!(!stored.diarize);
        assert_eq!(stored.speaker_count, Some(4));
        assert_eq!(stored.language.as_deref(), Some("en"));
    }

    async fn save_state() -> (AppState, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(
            crate::config::Config::for_tests(dir.path()),
            crate::db::open_memory().await.unwrap(),
        );
        sqlx::query(
            "INSERT INTO users (id, email, created_at, updated_at) VALUES ('u', 'u@x.test', 0, 0)",
        )
        .execute(&state.db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO recordings (id, user_id, device_sn, plaud_file_id, filename, duration, start_time, end_time, filesize, file_md5, storage_type, storage_path, plaud_version, created_at, updated_at)
             VALUES ('r', 'u', 'd', 'p', 'f', 0, 0, 0, 0, '', 'local', 'x', '1', 0, 0)",
        )
        .execute(&state.db)
        .await
        .unwrap();
        sqlx::query("INSERT INTO jobs (id, kind, user_id, recording_id, state, payload, run_after, created_at, updated_at) VALUES ('j', 'pipeline', 'u', 'r', 'running', '{}', 0, 0, 0)")
            .execute(&state.db)
            .await
            .unwrap();
        (state, dir)
    }

    /// The claim of the job `save_state` seeds: its first claim, generation 0.
    fn test_lease() -> Lease {
        Lease {
            id: "j".into(),
            lease_gen: 0,
        }
    }

    fn merged(text: &str) -> merge::Merged {
        merge::Merged {
            transcript: transcribe::Transcript {
                text: text.into(),
                language: Some("en".into()),
                segments: Vec::new(),
            },
            timeline: Vec::new(),
            timestamp_source: None,
            needs_alignment: true,
        }
    }

    /// A run interrupted after some chunks were finished: the next claim keeps those chunks,
    /// finds the saved speech detection, and only sends what is left.
    ///
    /// Needs a real recording and `ffmpeg`, so it runs only when `OAH_PIPELINE_FIXTURE` names a
    /// speech file: `cargo test -p oah --lib -- --ignored a_restart_reuses`.
    #[tokio::test]
    #[ignore]
    async fn a_restart_reuses_the_saved_speech_detection_and_finished_chunks() {
        let Ok(fixture) = std::env::var("OAH_PIPELINE_FIXTURE") else {
            eprintln!("skipped: set OAH_PIPELINE_FIXTURE to a speech recording");
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        let mut config = crate::config::Config::for_tests(dir.path());
        config.pipeline_enabled = true;
        let state = AppState::new(config, crate::db::open_memory().await.unwrap());
        // Storage keys are relative to the storage root.
        let storage = state.config.storage_root.join("r.wav");
        tokio::fs::create_dir_all(&state.config.storage_root)
            .await
            .unwrap();
        tokio::fs::copy(&fixture, &storage).await.unwrap();
        crate::pipeline::tests_support::seed_user_recording(&state, "r", "r.wav").await;

        // A provider that answers each chunk with a transcript covering its audio.
        let asked = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = asked.clone();
        let app = axum::Router::new().route(
            "/audio/transcriptions",
            axum::routing::post(move |body: axum::body::Bytes| {
                let counter = counter.clone();
                async move {
                    counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    // Two one-second spans per chunk, matching a real answer's shape.
                    axum::Json(serde_json::json!({
                        "text": "First part. Second part.",
                        "language": "en",
                        "duration": 2,
                        "segments": [
                            {"id": 0, "start": 0, "end": 1, "text": "First part."},
                            {"id": 1, "start": 1, "end": 2, "text": "Second part."}
                        ],
                        "_bytes": body.len(),
                    }))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        crate::pipeline::tests_support::seed_provider(&state, "u", &format!("http://{addr}")).await;

        let id = crate::jobs::enqueue(
            &state.db,
            crate::jobs::NewJob {
                kind: "pipeline",
                user_id: Some("u"),
                recording_id: Some("r"),
                payload: serde_json::json!({"language": null}),
            },
        )
        .await
        .unwrap();
        let first = crate::jobs::claim(&state.db, "pipeline", std::time::Duration::from_secs(120))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(first.id, id);
        // The run is stopped the way a crash stops it: the task is dropped after the provider
        // has answered a few chunks, so nothing writes an outcome and the work folder stays.
        let running = tokio::spawn(run(state.clone(), first.clone()));
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
        while asked.load(std::sync::atomic::Ordering::SeqCst) < 3 {
            assert!(
                std::time::Instant::now() < deadline,
                "the run never reached a provider call"
            );
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        running.abort();
        let _ = running.await;
        let sent_first = asked.load(std::sync::atomic::Ordering::SeqCst);
        let work = pipeline_dir(&state, &id);
        let vad_done = work.join("vad.complete").exists();

        let plan: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pipeline_chunks WHERE job_id = ?")
            .bind(&id)
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert!(plan > 0, "the run planned its chunks");
        let finished: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pipeline_chunks WHERE job_id = ? AND state = 'completed'",
        )
        .bind(&id)
        .fetch_one(&state.db)
        .await
        .unwrap();

        // Simulate the crash: the lease is gone, the job is claimed again.
        sqlx::query("UPDATE jobs SET lease_until = 0, state = 'running'")
            .execute(&state.db)
            .await
            .unwrap();
        let second = crate::jobs::claim(&state.db, "pipeline", std::time::Duration::from_secs(120))
            .await
            .unwrap()
            .unwrap();
        assert!(second.lease_gen > first.lease_gen);
        // The speech detection is not recomputed, which is what the marker proves.
        assert!(vad_done, "the first run saved its speech detection");
        let _ = run(state.clone(), second).await;
        let sent_after = asked.load(std::sync::atomic::Ordering::SeqCst);

        let done: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM transcriptions WHERE recording_id = 'r' AND user_id = 'u'",
        )
        .fetch_one(&state.db)
        .await
        .unwrap();
        assert_eq!(done, 1, "the restarted run stores one transcript");
        if finished > 0 {
            assert!(
                sent_after - sent_first < plan as usize,
                "finished chunks were not sent again: {finished} of {plan} were done, \
                 {} calls in total",
                sent_after
            );
        }
    }

    #[tokio::test]
    async fn the_worker_save_is_stopped_by_a_cancel_that_committed_first() {
        let (state, _dir) = save_state().await;
        sqlx::query(
            "INSERT INTO pipeline_runs (job_id, phase, updated_at) VALUES ('j', 'cancelled', 0)",
        )
        .execute(&state.db)
        .await
        .unwrap();
        let outcome = save_merged(
            &state,
            &test_lease(),
            "u",
            "r",
            "OpenAI",
            "whisper-1",
            &merged("late"),
        )
        .await;
        assert!(matches!(outcome, Err(Stop::Cancelled)));
        let stored: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM transcriptions")
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(stored, 0, "a cancelled job stores no transcript");
    }

    #[tokio::test]
    async fn the_worker_save_is_refused_after_the_lease_moved_on() {
        let (state, _dir) = save_state().await;
        // Another worker claimed the job after the lease expired.
        sqlx::query("UPDATE jobs SET lease_gen = 1")
            .execute(&state.db)
            .await
            .unwrap();
        let outcome = save_merged(
            &state,
            &test_lease(),
            "u",
            "r",
            "OpenAI",
            "whisper-1",
            &merged("stale"),
        )
        .await;
        assert!(matches!(outcome, Err(Stop::LeaseLost)));
        let stored: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM transcriptions")
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(stored, 0, "a replaced run stores no transcript");
    }

    #[tokio::test]
    async fn the_worker_save_writes_the_transcript_and_its_phase() {
        let (state, _dir) = save_state().await;
        sqlx::query(
            "INSERT INTO pipeline_runs (job_id, phase, updated_at) VALUES ('j', 'transcribing', 0)",
        )
        .execute(&state.db)
        .await
        .unwrap();
        save_merged(
            &state,
            &test_lease(),
            "u",
            "r",
            "OpenAI",
            "whisper-1",
            &merged("words"),
        )
        .await
        .ok()
        .unwrap();
        let stored: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM transcriptions")
            .fetch_one(&state.db)
            .await
            .unwrap();
        let phase: String =
            sqlx::query_scalar("SELECT phase FROM pipeline_runs WHERE job_id = 'j'")
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert_eq!((stored, phase.as_str()), (1, "needs_alignment"));
    }

    #[tokio::test]
    async fn unreadable_speaker_settings_are_a_retry_not_a_failure() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(
            crate::config::Config::for_tests(dir.path()),
            crate::db::open_memory().await.unwrap(),
        );
        sqlx::query(
            "INSERT INTO users (id, email, created_at, updated_at) VALUES ('u', 'u@x.test', 0, 0)",
        )
        .execute(&state.db)
        .await
        .unwrap();
        // Stored settings that cannot be parsed make the read fail.
        sqlx::query(
            "INSERT INTO user_settings (user_id, data, updated_at) VALUES ('u', 'not json', 0)",
        )
        .execute(&state.db)
        .await
        .unwrap();
        let outcome = run_options(&state, "u", "Fixture".into(), "whisper-1".into(), None).await;
        assert!(
            matches!(outcome, Err(Stop::Retry(_))),
            "an unreadable settings row is retried, not failed"
        );
    }

    #[test]
    fn wav_header_matches_pcm_length() {
        let wav = wav_bytes(&[1, 2, 3, 4]);
        assert_eq!(wav.len(), 48);
        assert_eq!(&wav[40..44], &4u32.to_le_bytes());
        assert_eq!(&wav[4..8], &40u32.to_le_bytes());
    }

    #[test]
    fn disk_budgets_follow_spec_section_12() {
        let pcm = 100;
        assert_eq!(decode_budget(pcm), pcm + 64 * MIB);
        // A paused job waits for the larger resume reserve; the PCM counts until it is on disk.
        assert_eq!(resume_budget(pcm, false), pcm + 512 * MIB);
        assert_eq!(resume_budget(pcm, true), 512 * MIB);
    }

    #[test]
    fn retry_delays_grow_and_cap() {
        assert!(
            retry_delay(1) >= Duration::from_secs(2)
                && retry_delay(1) <= Duration::from_secs_f64(2.4)
        );
        assert!(
            retry_delay(10) >= Duration::from_secs(120)
                && retry_delay(10) <= Duration::from_secs_f64(121.0)
        );
    }
}
