//! Transcription runs (spec/transcription.md) and automatic transcription of new recordings (spec/workers.md).

mod diarize;
mod engine;

pub use engine::transcribe_file;

use std::collections::HashMap;

use axum::Json;
use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path as UrlPath, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, post};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::AppState;
use crate::ai::{self, AiError, Provider};
use crate::auth::CurrentUser;
use crate::db::now_ms;
use crate::error::{ApiResult, AppError};
use crate::jobs::{self, Job, NewJob, Outcome};
use crate::{ids, routes, summary};

/// Longest recording the audio pipeline accepts: 24 hours.
const PIPELINE_MAX_MS: i64 = 86_400_000;
/// Automatic transcription stops retrying after this many attempts.
const AUTO_MAX_ATTEMPTS: i64 = 3;

/// One timed piece of a transcript. Times are seconds from the start of the audio.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Segment {
    pub start: f64,
    pub end: f64,
    pub text: String,
    pub speaker: Option<String>,
}

/// What a provider returned for one file.
#[derive(Debug, Clone, Default)]
pub struct Transcript {
    pub text: String,
    pub language: Option<String>,
    /// Empty when the provider gives no timings.
    pub segments: Vec<Segment>,
}

/// Per-run options taken from the request and the user's settings.
#[derive(Debug, Clone, Default)]
pub struct Options {
    /// Recording title, used as the upload file name.
    pub filename: String,
    pub model: String,
    pub language: Option<String>,
    pub diarize: bool,
    pub speaker_count: Option<u32>,
}

/// What to store for a finished run.
pub struct Saved<'a> {
    pub user_id: &'a str,
    pub recording_id: &'a str,
    pub transcript: &'a Transcript,
    pub provider: &'a str,
    pub model: &'a str,
    /// `server` or `browser`.
    pub transcription_type: &'a str,
    /// Pipeline timeline JSON and its source; `None` for whole-file runs.
    pub timeline: Option<(serde_json::Value, &'a str)>,
    /// The pipeline job that produced this transcript and the phase it ends in. The phase is
    /// written in the same transaction as the transcript, so a cancel that arrived first wins
    /// and a save that committed first is never overwritten (spec/audio-pipeline.md 13.1).
    pub job: Option<(&'a str, &'a str)>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/recordings/{id}/transcribe", post(transcribe))
        .route(
            "/api/recordings/{id}/transcription",
            delete(delete_transcript),
        )
}

/// Starts the worker for automatic transcription jobs.
pub fn spawn(state: &AppState) {
    let worker_state = state.clone();
    jobs::spawn_workers(
        state.db.clone(),
        state.wakeup.clone(),
        "transcribe",
        2,
        AUTO_MAX_ATTEMPTS,
        move |job: Job| {
            let state = worker_state.clone();
            async move { auto_step(&state, &job).await }
        },
    );
}

/// Stores a finished transcript, replacing the `openaudiohub` one, then runs the after-transcript steps.
pub async fn save_transcript(state: &AppState, saved: Saved<'_>) -> ApiResult<()> {
    let now = now_ms();
    let text = state.config.field_key.encrypt(&saved.transcript.text);
    let (timeline, timeline_source) = match &saved.timeline {
        Some((value, source)) => (
            Some(state.config.field_key.encrypt_json(value).to_string()),
            Some(*source),
        ),
        None => (None, None),
    };
    // BEGIN IMMEDIATE takes the write lock before the ownership read below, so a cancel that
    // commits at the same moment waits here instead of invalidating this snapshot. Without it a
    // concurrent cancel makes the phase write fail with SQLITE_BUSY_SNAPSHOT instead of the
    // clean JOB_CANCELLED answer.
    let mut tx = state.db.begin_with("BEGIN IMMEDIATE").await?;
    // The terminal phase is written in the same transaction as the transcript. A cancel that
    // committed first leaves the phase at `cancelled`, the guard misses, and the save rolls
    // back. A save that committed first leaves `completed`/`needs_alignment`, which the cancel
    // endpoint refuses to overwrite (spec/audio-pipeline.md section 13.1).
    if let Some((job_id, phase)) = saved.job {
        // The job must belong to the same user; the phase write stays scoped like every other
        // query of the save.
        let owner: Option<String> = sqlx::query_scalar("SELECT user_id FROM jobs WHERE id = ?")
            .bind(job_id)
            .fetch_optional(&mut *tx)
            .await?;
        if owner.as_deref() != Some(saved.user_id) {
            tx.rollback().await?;
            return Err(AppError::new(
                StatusCode::CONFLICT,
                "JOB_CANCELLED",
                "The job was cancelled",
            ));
        }
        let moved = sqlx::query(
            "INSERT INTO pipeline_runs (job_id, phase, updated_at) VALUES (?, ?, ?)
             ON CONFLICT (job_id) DO UPDATE SET phase = excluded.phase, updated_at = excluded.updated_at
             WHERE pipeline_runs.phase <> 'cancelled'",
        )
        .bind(job_id)
        .bind(phase)
        .bind(now)
        .execute(&mut *tx)
        .await?;
        if moved.rows_affected() == 0 {
            tx.rollback().await?;
            return Err(AppError::new(
                StatusCode::CONFLICT,
                "JOB_CANCELLED",
                "The job was cancelled",
            ));
        }
    }
    let previous: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM transcriptions WHERE recording_id = ? AND user_id = ?",
    )
    .bind(saved.recording_id)
    .bind(saved.user_id)
    .fetch_one(&mut *tx)
    .await?;
    // The summary was written from the old transcript, so it goes too.
    if previous > 0 {
        sqlx::query("DELETE FROM ai_enhancements WHERE recording_id = ? AND user_id = ?")
            .bind(saved.recording_id)
            .bind(saved.user_id)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("DELETE FROM transcriptions WHERE recording_id = ? AND user_id = ? AND source = 'openaudiohub'")
        .bind(saved.recording_id)
        .bind(saved.user_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO transcriptions (id, recording_id, user_id, text, detected_language, transcription_type, provider, model, timeline, timeline_source, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'openaudiohub', ?)",
    )
    .bind(ids::new_id())
    .bind(saved.recording_id)
    .bind(saved.user_id)
    .bind(text)
    .bind(&saved.transcript.language)
    .bind(saved.transcription_type)
    .bind(saved.provider)
    .bind(saved.model)
    .bind(timeline)
    .bind(timeline_source)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE recordings SET updated_at = ? WHERE id = ? AND user_id = ?")
        .bind(now)
        .bind(saved.recording_id)
        .bind(saved.user_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    summary::after_transcript(state, saved.user_id, saved.recording_id).await;
    Ok(())
}

/// Queues an automatic transcription for a new recording when the user turned it on.
/// Called after an upload or a Plaud sync adds a recording.
pub async fn queue_auto(state: &AppState, user_id: &str, recording_id: &str) -> ApiResult<()> {
    let settings = routes::settings::effective(state, user_id).await?;
    if settings.get("autoTranscribe").and_then(Value::as_bool) != Some(true) {
        return Ok(());
    }
    jobs::enqueue(
        &state.db,
        NewJob {
            kind: "transcribe",
            user_id: Some(user_id),
            recording_id: Some(recording_id),
            payload: json!({}),
        },
    )
    .await?;
    state.wakeup.notify();
    Ok(())
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct RunBody {
    provider_id: Option<String>,
    model: Option<String>,
}

type Shared = std::sync::Arc<tokio::sync::OnceCell<ApiResult<(StatusCode, Value)>>>;

/// Runs in progress per recording, so concurrent manual runs share one provider call.
static IN_FLIGHT: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, Shared>>> =
    std::sync::LazyLock::new(Default::default);

/// POST /api/recordings/{id}/transcribe: a forced manual run.
async fn transcribe(
    State(state): State<AppState>,
    user: CurrentUser,
    UrlPath(id): UrlPath<String>,
    body: Bytes,
) -> ApiResult<Response> {
    let body: RunBody = serde_json::from_slice(&body).unwrap_or_default();
    let key = format!(
        "{}:{id}:{}:{}",
        user.id,
        body.provider_id.as_deref().unwrap_or(""),
        body.model.as_deref().unwrap_or("")
    );
    let cell = IN_FLIGHT
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(key.clone())
        .or_default()
        .clone();
    let outcome = cell
        .get_or_init(|| async {
            match run(
                &state,
                &user.id,
                &id,
                body.provider_id.as_deref(),
                body.model.as_deref(),
                true,
            )
            .await
            {
                Ok(Run::Saved(t)) => Ok((
                    StatusCode::OK,
                    json!({ "transcription": t.text, "detectedLanguage": t.language }),
                )),
                Ok(Run::Queued(job_id)) => Ok((
                    StatusCode::ACCEPTED,
                    json!({ "jobId": job_id, "status": "queued" }),
                )),
                Err(RunError::Api(e)) => Err(e),
                Err(RunError::Provider(e)) => {
                    let mut err = AppError::new(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "TRANSCRIPTION_FAILED",
                        e.message.clone(),
                    );
                    err.source = Some(format!("{}: {}", e.code, e.message));
                    Err(err)
                }
            }
        })
        .await
        .clone();
    let mut flights = IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner());
    if flights
        .get(&key)
        .is_some_and(|c| std::sync::Arc::ptr_eq(c, &cell))
    {
        flights.remove(&key);
    }
    drop(flights);
    outcome.map(|(status, body)| (status, Json(body)).into_response())
}

/// DELETE /api/recordings/{id}/transcription: removes one source's transcript and the summary.
async fn delete_transcript(
    State(state): State<AppState>,
    user: CurrentUser,
    UrlPath(id): UrlPath<String>,
    Query(query): Query<HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let source = query
        .get("source")
        .map(String::as_str)
        .unwrap_or("openaudiohub");
    if !matches!(source, "openaudiohub" | "plaud" | "mixed") {
        return Err(AppError::bad_request(
            "INVALID_INPUT",
            "Unknown transcript source",
        ));
    }
    target(&state, &user.id, &id).await?;
    let active: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM jobs WHERE kind = 'pipeline' AND recording_id = ? AND state IN ('queued', 'running')",
    )
    .bind(&id)
    .fetch_one(&state.db)
    .await?;
    if active > 0 {
        return Err(AppError::new(
            StatusCode::CONFLICT,
            "CONFLICT",
            "An audio pipeline job is active for this recording",
        ));
    }
    let now = now_ms();
    let mut tx = state.db.begin().await?;
    let removed = sqlx::query(
        "DELETE FROM transcriptions WHERE recording_id = ? AND user_id = ? AND source = ?",
    )
    .bind(&id)
    .bind(&user.id)
    .bind(source)
    .execute(&mut *tx)
    .await?;
    if removed.rows_affected() == 0 {
        return Err(AppError::not_found(
            "NOT_FOUND",
            "No transcript of that source",
        ));
    }
    sqlx::query("DELETE FROM ai_enhancements WHERE recording_id = ? AND user_id = ?")
        .bind(&id)
        .bind(&user.id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE recordings SET updated_at = ? WHERE id = ? AND user_id = ?")
        .bind(now)
        .bind(&id)
        .bind(&user.id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(json!({ "success": true })))
}

#[derive(sqlx::FromRow)]
struct Target {
    storage_type: String,
    storage_path: String,
    duration: i64,
    title: String,
}

/// The recording a run works on. Missing, deleted, or another user's recordings are not found.
async fn target(state: &AppState, user_id: &str, recording_id: &str) -> ApiResult<Target> {
    let row: Option<(String, String, i64, String)> = sqlx::query_as(
        "SELECT storage_type, storage_path, duration, filename FROM recordings WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
    )
    .bind(recording_id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?;
    let (storage_type, storage_path, duration, title) =
        row.ok_or_else(|| AppError::not_found("RECORDING_NOT_FOUND", "Recording not found"))?;
    let title = state
        .config
        .field_key
        .decrypt(&title)
        .map_err(AppError::internal)?;
    Ok(Target {
        storage_type,
        storage_path,
        duration,
        title,
    })
}

/// Why a run did not save a transcript. Provider failures keep their retry hint for the worker.
enum RunError {
    Api(AppError),
    Provider(AiError),
}

impl From<AppError> for RunError {
    fn from(e: AppError) -> Self {
        Self::Api(e)
    }
}

enum Run {
    Saved(Transcript),
    /// The audio pipeline job id.
    Queued(String),
}

/// One transcription run: picks the provider, then either hands the file to the pipeline or
/// transcribes it here and saves the result.
async fn run(
    state: &AppState,
    user_id: &str,
    recording_id: &str,
    provider_id: Option<&str>,
    model: Option<&str>,
    manual: bool,
) -> Result<Run, RunError> {
    let result = run_once(state, user_id, recording_id, provider_id, model, manual).await;
    if let Err(RunError::Provider(e)) = &result {
        crate::webhooks::emit_soft(
            state,
            user_id,
            recording_id,
            "transcription.failed",
            Some(&e.message),
        )
        .await;
    }
    result
}

async fn run_once(
    state: &AppState,
    user_id: &str,
    recording_id: &str,
    provider_id: Option<&str>,
    model: Option<&str>,
    manual: bool,
) -> Result<Run, RunError> {
    let target = target(state, user_id, recording_id).await?;
    let provider = ai::transcription_provider(state, user_id, provider_id).await?;
    let model = model
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| provider.transcription_model());
    let options = run_options(state, user_id, model, target.title.clone()).await?;
    if state.config.pipeline_enabled {
        if target.duration > PIPELINE_MAX_MS {
            return Err(AppError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "TRANSCRIPTION_FAILED",
                "Recordings over 24 hours cannot be transcribed",
            )
            .into());
        }
        let job = queue_pipeline(state, user_id, recording_id, &provider, &options, manual).await?;
        return Ok(Run::Queued(job));
    }
    // The provider reads a local file, so object storage is fetched to a temporary file first.
    let source = state
        .storage
        .materialize(&target.storage_type, &target.storage_path)
        .await
        .map_err(AppError::from)?;
    let transcript = transcribe_file(state, &provider, source.path(), &options)
        .await
        .map_err(RunError::Provider)?;
    save_transcript(
        state,
        Saved {
            user_id,
            recording_id,
            transcript: &transcript,
            provider: provider.name.as_str(),
            model: options.model.as_str(),
            transcription_type: "server",
            timeline: None,
            job: None,
        },
    )
    .await?;
    Ok(Run::Saved(transcript))
}

async fn run_options(
    state: &AppState,
    user_id: &str,
    model: String,
    filename: String,
) -> ApiResult<Options> {
    let settings = routes::settings::effective(state, user_id).await?;
    let (diarize, speaker_count) = speaker_settings_from(&settings);
    Ok(Options {
        filename,
        model,
        language: settings
            .get("defaultTranscriptionLanguage")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(str::to_owned),
        diarize,
        speaker_count,
    })
}

/// The speaker settings of one run, read from a user's effective settings. Shared by the
/// synchronous path and the pipeline worker (spec/transcription.md, spec/audio-pipeline.md).
pub async fn speaker_settings(state: &AppState, user_id: &str) -> ApiResult<(bool, Option<u32>)> {
    let settings = routes::settings::effective(state, user_id).await?;
    Ok(speaker_settings_from(&settings))
}

fn speaker_settings_from(settings: &serde_json::Map<String, Value>) -> (bool, Option<u32>) {
    let diarize = settings
        .get("speakerDiarization")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let count = settings
        .get("diarizationSpeakerCount")
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok());
    (diarize, count)
}

/// Creates the audio pipeline job. A forced run first cancels the recording's active pipeline job.
async fn queue_pipeline(
    state: &AppState,
    user_id: &str,
    recording_id: &str,
    provider: &Provider,
    options: &Options,
    manual: bool,
) -> ApiResult<String> {
    if manual {
        crate::pipeline::supersede(state, user_id, recording_id).await?;
    }
    let payload = json!({
        "providerId": provider.id,
        "model": options.model,
        "language": options.language,
        "trigger": if manual { "manual" } else { "auto" },
    });
    let job = jobs::enqueue(
        &state.db,
        NewJob {
            kind: "pipeline",
            user_id: Some(user_id),
            recording_id: Some(recording_id),
            payload,
        },
    )
    .await?;
    state.wakeup.notify();
    Ok(job)
}

/// One automatic run for a queued recording, as the worker sees it.
async fn auto_step(state: &AppState, job: &Job) -> Outcome {
    let (Some(user), Some(recording)) = (job.user_id.as_deref(), job.recording_id.as_deref())
    else {
        return Outcome::Failed {
            code: "INVALID_INPUT",
            message: "Transcription job has no recording".into(),
        };
    };
    match needs_transcript(state, user, recording).await {
        Ok(true) => {}
        Ok(false) => return Outcome::Done,
        Err(e) => {
            return Outcome::Retry {
                code: e.code,
                message: e.message,
                after: jobs::backoff(job.attempts),
            };
        }
    }
    match run(state, user, recording, None, None, false).await {
        Ok(_) => Outcome::Done,
        Err(RunError::Api(e)) => Outcome::Failed {
            code: e.code,
            message: e.message,
        },
        Err(RunError::Provider(e)) if e.retryable => Outcome::Retry {
            code: e.code,
            message: e.message,
            after: jobs::backoff(job.attempts),
        },
        Err(RunError::Provider(e)) => Outcome::Failed {
            code: e.code,
            message: e.message,
        },
    }
}

/// True when the recording still exists and has no transcript yet.
async fn needs_transcript(state: &AppState, user_id: &str, recording_id: &str) -> ApiResult<bool> {
    let found: i64 = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM recordings r WHERE r.id = ? AND r.user_id = ? AND r.deleted_at IS NULL)
            AND NOT EXISTS (SELECT 1 FROM transcriptions t WHERE t.recording_id = ? AND t.user_id = ?)",
    )
    .bind(recording_id)
    .bind(user_id)
    .bind(recording_id)
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;
    Ok(found == 1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;

    async fn state(dir: &std::path::Path) -> AppState {
        AppState::new(
            Config::for_tests(dir),
            crate::db::open_memory().await.unwrap(),
        )
    }

    async fn seed_user_recording(state: &AppState) {
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
    }

    #[tokio::test]
    async fn speaker_settings_follow_the_users_settings() {
        let dir = tempfile::tempdir().unwrap();
        let state = state(dir.path()).await;
        seed_user_recording(&state).await;
        assert_eq!(speaker_settings(&state, "u").await.unwrap(), (true, None));
        sqlx::query("INSERT INTO user_settings (user_id, data, updated_at) VALUES ('u', ?, 0)")
            .bind(json!({"speakerDiarization": false, "diarizationSpeakerCount": 3}).to_string())
            .execute(&state.db)
            .await
            .unwrap();
        assert_eq!(
            speaker_settings(&state, "u").await.unwrap(),
            (false, Some(3))
        );
    }

    fn transcript(text: &str) -> Transcript {
        Transcript {
            text: text.into(),
            language: None,
            segments: Vec::new(),
        }
    }

    #[tokio::test]
    async fn a_forced_run_replaces_the_active_job_through_queue_pipeline() {
        let dir = tempfile::tempdir().unwrap();
        let state = state(dir.path()).await;
        seed_user_recording(&state).await;
        sqlx::query("INSERT INTO jobs (id, kind, user_id, recording_id, state, payload, run_after, created_at, updated_at) VALUES ('old', 'pipeline', 'u', 'r', 'running', '{}', 0, 0, 0)")
            .execute(&state.db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO pipeline_runs (job_id, phase, updated_at) VALUES ('old', 'transcribing', 0)")
            .execute(&state.db)
            .await
            .unwrap();
        let work = state.config.storage_root.join(".pipeline").join("old");
        std::fs::create_dir_all(&work).unwrap();
        std::fs::write(work.join("audio.pcm"), b"pcm").unwrap();
        let provider = Provider {
            id: "p".into(),
            name: "OpenAI".into(),
            base_url: "http://127.0.0.1:1".into(),
            api_key: "k".into(),
            model: Some("whisper-1".into()),
        };
        let options = Options {
            filename: "Fixture".into(),
            model: "whisper-1".into(),
            language: None,
            diarize: true,
            speaker_count: None,
        };
        let new_id = queue_pipeline(&state, "u", "r", &provider, &options, true)
            .await
            .unwrap();
        assert_ne!(new_id, "old", "a forced run queues a new job");
        assert!(!work.exists(), "the superseded work folder is removed");
        let old_state: String = sqlx::query_scalar("SELECT state FROM jobs WHERE id = 'old'")
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(old_state, "cancelled");
    }

    #[tokio::test]
    async fn a_cancelled_job_never_saves_a_transcript() {
        let dir = tempfile::tempdir().unwrap();
        let state = state(dir.path()).await;
        seed_user_recording(&state).await;
        sqlx::query("INSERT INTO jobs (id, kind, user_id, recording_id, state, payload, run_after, created_at, updated_at) VALUES ('j', 'pipeline', 'u', 'r', 'cancelled', '{}', 0, 0, 0)")
            .execute(&state.db)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO pipeline_runs (job_id, phase, updated_at) VALUES ('j', 'cancelled', 0)",
        )
        .execute(&state.db)
        .await
        .unwrap();
        let text = transcript("late words");
        let err = save_transcript(
            &state,
            Saved {
                user_id: "u",
                recording_id: "r",
                transcript: &text,
                provider: "OpenAI",
                model: "whisper-1",
                transcription_type: "server",
                timeline: None,
                job: Some(("j", "completed")),
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "JOB_CANCELLED");
        let stored: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM transcriptions")
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(stored, 0);
    }

    /// A file-backed database, so two connections can really run at once.
    async fn file_state(dir: &std::path::Path) -> AppState {
        AppState::new(
            Config::for_tests(dir),
            crate::db::open(&dir.join("test.sqlite")).await.unwrap(),
        )
    }

    #[tokio::test]
    async fn a_write_that_holds_the_lock_does_not_break_the_save() {
        // The save takes the write lock before it reads anything. Another writer that already
        // holds the lock therefore makes the save wait, instead of failing its phase write with
        // SQLITE_BUSY_SNAPSHOT after the ownership read.
        let dir = tempfile::tempdir().unwrap();
        let state = file_state(dir.path()).await;
        seed_user_recording(&state).await;
        sqlx::query("INSERT INTO jobs (id, kind, user_id, recording_id, state, payload, run_after, created_at, updated_at) VALUES ('j', 'pipeline', 'u', 'r', 'running', '{}', 0, 0, 0)")
            .execute(&state.db)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO pipeline_runs (job_id, phase, updated_at) VALUES ('j', 'transcribing', 0)",
        )
        .execute(&state.db)
        .await
        .unwrap();
        // Another writer takes the write lock and holds it for a moment.
        let mut holder = state.db.acquire().await.unwrap();
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *holder)
            .await
            .unwrap();
        sqlx::query("UPDATE jobs SET updated_at = updated_at WHERE id = 'j'")
            .execute(&mut *holder)
            .await
            .unwrap();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            sqlx::query("COMMIT").execute(&mut *holder).await.unwrap();
        });
        let text = transcript("words");
        let saved = save_transcript(
            &state,
            Saved {
                user_id: "u",
                recording_id: "r",
                transcript: &text,
                provider: "OpenAI",
                model: "whisper-1",
                transcription_type: "server",
                timeline: None,
                job: Some(("j", "completed")),
            },
        )
        .await;
        assert!(
            saved.is_ok(),
            "the save waits for the lock instead of failing, got {:?}",
            saved.err().map(|e| e.code)
        );
        let phase: String =
            sqlx::query_scalar("SELECT phase FROM pipeline_runs WHERE job_id = 'j'")
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert_eq!(phase, "completed");
    }

    #[tokio::test]
    async fn a_save_refuses_a_job_of_another_user() {
        let dir = tempfile::tempdir().unwrap();
        let state = state(dir.path()).await;
        seed_user_recording(&state).await;
        sqlx::query("INSERT INTO users (id, email, created_at, updated_at) VALUES ('other', 'o@x.test', 0, 0)")
            .execute(&state.db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO jobs (id, kind, user_id, recording_id, state, payload, run_after, created_at, updated_at) VALUES ('j', 'pipeline', 'other', NULL, 'running', '{}', 0, 0, 0)")
            .execute(&state.db)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO pipeline_runs (job_id, phase, updated_at) VALUES ('j', 'transcribing', 0)",
        )
        .execute(&state.db)
        .await
        .unwrap();
        let text = transcript("words");
        let err = save_transcript(
            &state,
            Saved {
                user_id: "u",
                recording_id: "r",
                transcript: &text,
                provider: "OpenAI",
                model: "whisper-1",
                transcription_type: "server",
                timeline: None,
                job: Some(("j", "completed")),
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "JOB_CANCELLED");
        let stored: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM transcriptions")
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(stored, 0);
    }

    #[tokio::test]
    async fn a_save_writes_the_transcript_and_its_final_phase_together() {
        let dir = tempfile::tempdir().unwrap();
        let state = state(dir.path()).await;
        seed_user_recording(&state).await;
        sqlx::query("INSERT INTO jobs (id, kind, user_id, recording_id, state, payload, run_after, created_at, updated_at) VALUES ('j', 'pipeline', 'u', 'r', 'running', '{}', 0, 0, 0)")
            .execute(&state.db)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO pipeline_runs (job_id, phase, updated_at) VALUES ('j', 'transcribing', 0)",
        )
        .execute(&state.db)
        .await
        .unwrap();
        let text = transcript("words");
        save_transcript(
            &state,
            Saved {
                user_id: "u",
                recording_id: "r",
                transcript: &text,
                provider: "OpenAI",
                model: "whisper-1",
                transcription_type: "server",
                timeline: None,
                job: Some(("j", "completed")),
            },
        )
        .await
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
        assert_eq!((stored, phase.as_str()), (1, "completed"));
    }
}
