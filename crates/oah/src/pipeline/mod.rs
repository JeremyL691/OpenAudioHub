//! Audio pipeline for long recordings (spec/audio-pipeline.md and the "Audio pipeline status"
//! section of spec/transcription.md). The worker runs in this process; the routes here show
//! and change the state of a recording's latest pipeline job.

mod merge;
mod plan;
mod run;
mod vad;

use axum::Json;
use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path as UrlPath, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use serde_json::{Value, json};

use crate::AppState;
use crate::auth::CurrentUser;
use crate::db::now_ms;
use crate::error::{ApiResult, AppError};
use crate::time::iso;

/// Chunk results are kept per job; a job that fails this often stops.
const MAX_JOB_ATTEMPTS: i64 = 3;

pub fn router() -> Router<AppState> {
    Router::new().route(
        "/api/recordings/{id}/audio-pipeline",
        get(status).post(action),
    )
}

/// Starts the pipeline worker.
pub fn spawn(state: &AppState) {
    let worker_state = state.clone();
    crate::jobs::spawn_workers(
        state.db.clone(),
        state.wakeup.clone(),
        "pipeline",
        1,
        MAX_JOB_ATTEMPTS,
        move |job| run::run(worker_state.clone(), job),
    );
}

/// Replaces the recording's active pipeline job before a forced manual run: the job is
/// cancelled, freed from the one-active-job index, and its work folder is deleted
/// (spec/audio-pipeline.md sections 3.1 and 13.3).
pub async fn supersede(state: &AppState, recording_id: &str) -> sqlx::Result<()> {
    let now = now_ms();
    let ids: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM jobs WHERE kind = 'pipeline' AND recording_id = ? AND state IN ('queued', 'running')",
    )
    .bind(recording_id)
    .fetch_all(&state.db)
    .await?;
    for id in &ids {
        let phase: Option<String> =
            sqlx::query_scalar("SELECT phase FROM pipeline_runs WHERE job_id = ?")
                .bind(id)
                .fetch_optional(&state.db)
                .await?;
        match phase.as_deref() {
            // The worker finished first. Its transcript stands until the new run replaces it.
            Some("completed") | Some("needs_alignment") => {
                sqlx::query(
                    "UPDATE jobs SET state = 'done', progress = 1, finished_at = ?, lease_until = NULL, updated_at = ?
                     WHERE id = ? AND state IN ('queued', 'running')",
                )
                .bind(now)
                .bind(now)
                .bind(id)
                .execute(&state.db)
                .await?;
            }
            Some("failed") => {
                sqlx::query(
                    "UPDATE jobs SET state = 'failed', finished_at = ?, lease_until = NULL, updated_at = ?
                     WHERE id = ? AND state IN ('queued', 'running')",
                )
                .bind(now)
                .bind(now)
                .bind(id)
                .execute(&state.db)
                .await?;
            }
            Some("cancelled") => {
                sqlx::query(
                    "UPDATE jobs SET state = 'cancelled', finished_at = ?, lease_until = NULL, updated_at = ?
                     WHERE id = ? AND state IN ('queued', 'running')",
                )
                .bind(now)
                .bind(now)
                .bind(id)
                .execute(&state.db)
                .await?;
            }
            _ => {
                // The phase is what the worker checks, so this stops a running worker too.
                if run::cancel(&state.db, id).await? {
                    sqlx::query(
                        "UPDATE jobs SET state = 'cancelled', finished_at = ?, lease_until = NULL, updated_at = ?
                         WHERE id = ? AND state IN ('queued', 'running')",
                    )
                    .bind(now)
                    .bind(now)
                    .bind(id)
                    .execute(&state.db)
                    .await?;
                }
            }
        }
        let _ = tokio::fs::remove_dir_all(run::pipeline_dir(state, id)).await;
    }
    Ok(())
}

/// Text, language, timeline JSON and timeline source of a stored transcript.
type TranscriptRow = (String, Option<String>, Option<String>, Option<String>);

#[derive(sqlx::FromRow)]
struct JobRow {
    id: String,
    state: String,
    phase: String,
    progress: f64,
    error_code: Option<String>,
    error_message: Option<String>,
    updated_at: i64,
}

/// The newest pipeline job of one recording of one user.
async fn latest_job(
    state: &AppState,
    user_id: &str,
    recording_id: &str,
) -> sqlx::Result<Option<JobRow>> {
    sqlx::query_as(
        "SELECT j.id, j.state, COALESCE(p.phase, 'queued') AS phase, j.progress, j.error_code, j.error_message, j.updated_at
         FROM jobs j LEFT JOIN pipeline_runs p ON p.job_id = j.id
         WHERE j.kind = 'pipeline' AND j.recording_id = ? AND j.user_id = ?
         ORDER BY j.created_at DESC, j.rowid DESC LIMIT 1",
    )
    .bind(recording_id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await
}

/// The status names of spec/transcription.md, from the stored state and phase.
fn status_of(job_state: &str, phase: &str) -> &'static str {
    if phase == "cancelled" || job_state == "cancelled" {
        "cancelled"
    } else if job_state == "failed" {
        "failed"
    } else if phase == "completed" {
        "completed"
    } else if phase == "needs_alignment" {
        "needs_alignment"
    } else if job_state == "queued" {
        "queued"
    } else if phase == "paused_disk" {
        "paused_disk"
    } else {
        "running"
    }
}

async fn status(
    State(state): State<AppState>,
    user: CurrentUser,
    UrlPath(id): UrlPath<String>,
) -> ApiResult<Json<Value>> {
    let exists: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM recordings WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
    )
    .bind(&id)
    .bind(&user.id)
    .fetch_optional(&state.db)
    .await?;
    if exists.is_none() {
        return Ok(Json(
            json!({ "job": null, "timeline": null, "timestampSource": null, "transcription": null }),
        ));
    }

    let job = latest_job(&state, &user.id, &id).await?;
    let transcript: Option<TranscriptRow> = sqlx::query_as(
        "SELECT text, detected_language, timeline, timeline_source FROM transcriptions
         WHERE recording_id = ? AND user_id = ? AND source = 'openaudiohub' ORDER BY created_at DESC LIMIT 1",
    )
    .bind(&id)
    .bind(&user.id)
    .fetch_optional(&state.db)
    .await?;

    let job_json = match &job {
        Some(j) => json!({
            "id": j.id,
            "status": status_of(&j.state, &j.phase),
            "phase": j.phase,
            "progress": j.progress,
            "errorType": j.error_code,
            "error": j.error_message,
            "updatedAt": iso(j.updated_at),
        }),
        None => Value::Null,
    };
    let show_transcript = match &job {
        None => true,
        Some(j) => matches!(
            status_of(&j.state, &j.phase),
            "completed" | "needs_alignment"
        ),
    };
    let (timeline, timestamp_source, transcription) = match transcript {
        Some((text, language, timeline, source)) => {
            let text = state
                .config
                .field_key
                .decrypt(&text)
                .map_err(AppError::internal)?;
            let timeline = timeline
                .as_deref()
                .and_then(|t| serde_json::from_str::<Value>(t).ok())
                .and_then(|v| state.config.field_key.decrypt_json(&v).ok());
            let transcription = if show_transcript {
                let mut t = json!({ "text": text, "source": "openaudiohub" });
                if let Some(language) = language {
                    t["language"] = json!(language);
                }
                t
            } else {
                Value::Null
            };
            (
                timeline.unwrap_or(Value::Null),
                source.map_or(Value::Null, Value::from),
                transcription,
            )
        }
        None => (Value::Null, Value::Null, Value::Null),
    };
    Ok(Json(json!({
        "job": job_json,
        "timeline": timeline,
        "timestampSource": timestamp_source,
        "transcription": transcription,
    })))
}

/// Replies with the `{ "error": ... }` body these routes use (no `code`).
fn reply(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

async fn action(
    State(state): State<AppState>,
    user: CurrentUser,
    UrlPath(id): UrlPath<String>,
    body: Bytes,
) -> Response {
    let action = serde_json::from_slice::<Value>(&body)
        .ok()
        .and_then(|v| v.get("action").and_then(Value::as_str).map(str::to_owned));
    match action.as_deref() {
        Some(action @ ("retry" | "cancel")) => match change(&state, &user.id, &id, action).await {
            Ok(response) => response,
            Err(e) => e.into_response(),
        },
        _ => reply(StatusCode::BAD_REQUEST, "Invalid action"),
    }
}

async fn change(
    state: &AppState,
    user_id: &str,
    recording_id: &str,
    action: &str,
) -> ApiResult<Response> {
    let Some(job) = latest_job(state, user_id, recording_id).await? else {
        return Ok(reply(StatusCode::NOT_FOUND, "Audio job not found"));
    };
    let status = status_of(&job.state, &job.phase);
    let now = now_ms();
    if action == "retry" {
        if status != "failed" {
            return Ok(reply(StatusCode::CONFLICT, "Audio job cannot be changed"));
        }
        // Completed chunks are kept; failed or unfinished ones are sent again.
        let mut tx = state.db.begin().await?;
        let moved = sqlx::query(
            "UPDATE jobs SET state = 'queued', run_after = ?, error_code = NULL, error_message = NULL, progress = 0,
             finished_at = NULL, lease_until = NULL, updated_at = ? WHERE id = ? AND state = 'failed'",
        )
        .bind(now)
        .bind(now)
        .bind(&job.id)
        .execute(&mut *tx)
        .await?;
        if moved.rows_affected() == 0 {
            return Ok(reply(StatusCode::CONFLICT, "Audio job cannot be changed"));
        }
        sqlx::query(
            "INSERT INTO pipeline_runs (job_id, phase, updated_at) VALUES (?, 'queued', ?)
             ON CONFLICT (job_id) DO UPDATE SET phase = 'queued', updated_at = excluded.updated_at",
        )
        .bind(&job.id)
        .bind(now)
        .execute(&mut *tx)
        .await?;
        sqlx::query("UPDATE pipeline_chunks SET state = 'queued', attempts = 0, error_code = NULL, error_message = NULL WHERE job_id = ? AND state <> 'completed'")
            .bind(&job.id)
            .execute(&mut *tx)
            .await?;
        // The retried run resolves the current default provider, not the stored one.
        sqlx::query("UPDATE jobs SET payload = json_remove(payload, '$.providerId') WHERE id = ?")
            .bind(&job.id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        state.wakeup.notify();
        return Ok((
            StatusCode::OK,
            Json(json!({ "jobId": job.id, "status": "queued" })),
        )
            .into_response());
    }

    if !matches!(status, "queued" | "running" | "paused_disk") {
        return Ok(reply(StatusCode::CONFLICT, "Audio job cannot be changed"));
    }
    // The worker sees the cancelled phase at its next check and removes the files itself. A
    // job that finished its save first cannot be cancelled any more (section 13.1).
    if !run::cancel(&state.db, &job.id).await? {
        return Ok(reply(StatusCode::CONFLICT, "Audio job cannot be changed"));
    }
    sqlx::query("UPDATE jobs SET state = 'cancelled', finished_at = ?, lease_until = NULL, updated_at = ? WHERE id = ? AND state = 'queued'")
        .bind(now)
        .bind(now)
        .bind(&job.id)
        .execute(&state.db)
        .await?;
    if job.state == "queued" {
        let _ = tokio::fs::remove_dir_all(run::pipeline_dir(state, &job.id)).await;
    }
    Ok((
        StatusCode::OK,
        Json(json!({ "jobId": job.id, "status": "cancelled" })),
    )
        .into_response())
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

    async fn seed_job(state: &AppState, job_state: &str, phase: &str) {
        sqlx::query("INSERT INTO jobs (id, kind, user_id, recording_id, state, payload, run_after, created_at, updated_at) VALUES ('j', 'pipeline', 'u', 'r', ?, '{}', 0, 0, 0)")
            .bind(job_state)
            .execute(&state.db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO pipeline_runs (job_id, phase, updated_at) VALUES ('j', ?, 0)")
            .bind(phase)
            .execute(&state.db)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn a_forced_run_removes_the_superseded_work_folder() {
        let dir = tempfile::tempdir().unwrap();
        let state = state(dir.path()).await;
        seed_user_recording(&state).await;
        seed_job(&state, "running", "transcribing").await;
        let work = run::pipeline_dir(&state, "j");
        std::fs::create_dir_all(&work).unwrap();
        std::fs::write(work.join("audio.pcm"), b"pcm").unwrap();
        supersede(&state, "r").await.unwrap();
        assert!(!work.exists(), "superseded work folder is removed");
        let job_state: String = sqlx::query_scalar("SELECT state FROM jobs WHERE id = 'j'")
            .fetch_one(&state.db)
            .await
            .unwrap();
        let phase: String =
            sqlx::query_scalar("SELECT phase FROM pipeline_runs WHERE job_id = 'j'")
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert_eq!(
            (job_state.as_str(), phase.as_str()),
            ("cancelled", "cancelled")
        );
    }

    #[tokio::test]
    async fn a_forced_run_keeps_a_result_that_was_saved_first() {
        let dir = tempfile::tempdir().unwrap();
        let state = state(dir.path()).await;
        seed_user_recording(&state).await;
        seed_job(&state, "running", "completed").await;
        supersede(&state, "r").await.unwrap();
        let job_state: String = sqlx::query_scalar("SELECT state FROM jobs WHERE id = 'j'")
            .fetch_one(&state.db)
            .await
            .unwrap();
        let phase: String =
            sqlx::query_scalar("SELECT phase FROM pipeline_runs WHERE job_id = 'j'")
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert_eq!((job_state.as_str(), phase.as_str()), ("done", "completed"));
    }

    #[tokio::test]
    async fn a_cancel_after_the_saved_result_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let state = state(dir.path()).await;
        seed_user_recording(&state).await;
        seed_job(&state, "running", "completed").await;
        let response = change(&state, "u", "r", "cancel").await.unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let phase: String =
            sqlx::query_scalar("SELECT phase FROM pipeline_runs WHERE job_id = 'j'")
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert_eq!(phase, "completed");
    }
}
