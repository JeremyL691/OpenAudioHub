//! Export and backup: `GET /api/export`, backup jobs and downloads, scheduled backups and auto export.
//! Behavior is described in spec/export-backup.md.

mod archive;
mod export;
mod schedule;

use std::collections::HashMap;

use axum::Json;
use axum::Router;
use axum::extract::{Path as UrlPath, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use serde_json::{Value, json};
use sqlx::SqlitePool;

use crate::auth::CurrentUser;
use crate::crypto::FieldKey;
use crate::db::now_ms;
use crate::error::{ApiResult, AppError};
use crate::{AppState, ids, jobs, time};

const DAY_MS: i64 = 24 * 3600 * 1000;
const RETENTION_MS: i64 = 7 * DAY_MS;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/export", get(export::get))
        .route("/api/backup", get(list_jobs).post(start))
        .route("/api/backup/{id}", get(get_job))
        .route("/api/backup/{id}/download", get(archive::download))
}

/// Starts this module's background workers.
pub fn spawn(state: &AppState) {
    let worker_state = state.clone();
    jobs::spawn_workers(
        state.db.clone(),
        state.wakeup.clone(),
        "backup",
        1,
        3,
        move |job| {
            let st = worker_state.clone();
            async move { archive::run(&st, job).await }
        },
    );
    schedule::spawn(state);
}

// ---- export_jobs rows and their JSON form ----

const JOB_COLS: &str = "id, user_id, status, kind, storage_key, file_size, recording_count, error_message, \
    created_at, completed_at, expires_at";

#[derive(sqlx::FromRow)]
pub(super) struct JobRow {
    pub id: String,
    pub user_id: String,
    pub status: String,
    pub kind: String,
    pub storage_key: Option<String>,
    pub file_size: Option<i64>,
    pub recording_count: Option<i64>,
    pub error_message: Option<String>,
    pub created_at: i64,
    pub completed_at: Option<i64>,
    pub expires_at: Option<i64>,
}

/// The job as the API shows it. A completed job past its window reads as `expired`.
fn job_json(job: &JobRow, now: i64) -> Value {
    let expired = job.status == "completed" && job.expires_at.is_some_and(|e| e < now);
    json!({
        "id": job.id,
        "status": if expired { "expired" } else { job.status.as_str() },
        "createdAt": time::iso(job.created_at),
        "completedAt": job.completed_at.map(time::iso),
        "expiresAt": job.expires_at.map(time::iso),
        "recordingCount": job.recording_count,
        "fileSize": job.file_size,
        "errorMessage": job.error_message,
    })
}

fn job_response(status: StatusCode, job: &JobRow) -> Response {
    (status, Json(json!({ "job": job_json(job, now_ms()) }))).into_response()
}

async fn load_job(db: &SqlitePool, id: &str) -> ApiResult<Option<JobRow>> {
    let sql = format!("SELECT {JOB_COLS} FROM export_jobs WHERE id = ?");
    Ok(sqlx::query_as(&sql).bind(id).fetch_optional(db).await?)
}

async fn active_job(db: &SqlitePool, user_id: &str) -> ApiResult<Option<JobRow>> {
    let sql = format!(
        "SELECT {JOB_COLS} FROM export_jobs WHERE user_id = ? AND status IN ('pending', 'processing') \
         ORDER BY created_at DESC LIMIT 1"
    );
    Ok(sqlx::query_as(&sql)
        .bind(user_id)
        .fetch_optional(db)
        .await?)
}

/// Inserts a pending job and queues it. `None` when the user already has an active job.
pub(super) async fn queue(
    state: &AppState,
    user_id: &str,
    kind: &str,
) -> ApiResult<Option<String>> {
    let id = ids::new_id();
    let inserted = sqlx::query(
        "INSERT INTO export_jobs (id, user_id, status, kind, attempts, created_at) \
         VALUES (?, ?, 'pending', ?, 0, ?) ON CONFLICT DO NOTHING",
    )
    .bind(&id)
    .bind(user_id)
    .bind(kind)
    .bind(now_ms())
    .execute(&state.db)
    .await?
    .rows_affected();
    if inserted == 0 {
        return Ok(None);
    }
    jobs::enqueue(
        &state.db,
        jobs::NewJob {
            kind: "backup",
            user_id: Some(user_id),
            recording_id: None,
            payload: json!({ "exportJobId": id }),
        },
    )
    .await?;
    state.wakeup.notify();
    Ok(Some(id))
}

// ---- routes ----

async fn start(State(state): State<AppState>, user: CurrentUser) -> ApiResult<Response> {
    if let Some(job) = active_job(&state.db, &user.id).await? {
        return Ok(job_response(StatusCode::ACCEPTED, &job));
    }
    let last = sqlx::query_as::<_, (Option<i64>,)>(
        "SELECT MAX(completed_at) FROM export_jobs WHERE user_id = ? AND status = 'completed'",
    )
    .bind(&user.id)
    .fetch_one(&state.db)
    .await?
    .0;
    if let Some(done) = last.filter(|t| *t > now_ms() - DAY_MS) {
        let sql = format!(
            "SELECT {JOB_COLS} FROM export_jobs WHERE user_id = ? AND status = 'completed' AND completed_at = ? LIMIT 1"
        );
        if let Some(job) = sqlx::query_as::<_, JobRow>(&sql)
            .bind(&user.id)
            .bind(done)
            .fetch_optional(&state.db)
            .await?
        {
            return Ok(job_response(StatusCode::OK, &job));
        }
    }
    let job = match queue(&state, &user.id, "manual").await? {
        Some(id) => load_job(&state.db, &id)
            .await?
            .ok_or_else(|| AppError::internal("queued job missing"))?,
        // Lost a race with another request: that request's job is the active one.
        None => active_job(&state.db, &user.id)
            .await?
            .ok_or_else(|| AppError::internal("active job missing"))?,
    };
    Ok(job_response(StatusCode::ACCEPTED, &job))
}

async fn list_jobs(State(state): State<AppState>, user: CurrentUser) -> ApiResult<Json<Value>> {
    let sql = format!(
        "SELECT {JOB_COLS} FROM export_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT 10"
    );
    let rows: Vec<JobRow> = sqlx::query_as(&sql)
        .bind(&user.id)
        .fetch_all(&state.db)
        .await?;
    let now = now_ms();
    Ok(Json(
        json!({ "jobs": rows.iter().map(|r| job_json(r, now)).collect::<Vec<_>>() }),
    ))
}

/// The user's own job, or `NOT_FOUND` (other users' jobs look the same as missing ones).
pub(super) async fn owned_job(state: &AppState, user_id: &str, id: &str) -> ApiResult<JobRow> {
    let sql = format!("SELECT {JOB_COLS} FROM export_jobs WHERE id = ? AND user_id = ?");
    sqlx::query_as::<_, JobRow>(&sql)
        .bind(id)
        .bind(user_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::not_found("NOT_FOUND", "Export job not found"))
}

async fn get_job(
    State(state): State<AppState>,
    user: CurrentUser,
    UrlPath(id): UrlPath<String>,
) -> ApiResult<Json<Value>> {
    let job = owned_job(&state, &user.id, &id).await?;
    Ok(Json(json!({ "job": job_json(&job, now_ms()) })))
}

// ---- shared recording data ----

#[derive(sqlx::FromRow)]
pub(super) struct RecRow {
    pub id: String,
    pub plaud_file_id: String,
    pub filename: String,
    pub device_sn: String,
    pub duration: i64,
    pub start_time: i64,
    pub end_time: i64,
    pub filesize: i64,
    pub storage_type: String,
    pub storage_path: String,
}

/// Live (not deleted) recordings of a user.
pub(super) async fn live_recordings(db: &SqlitePool, user_id: &str) -> ApiResult<Vec<RecRow>> {
    Ok(sqlx::query_as(
        "SELECT id, plaud_file_id, filename, device_sn, duration, start_time, end_time, filesize, storage_type, storage_path \
         FROM recordings WHERE user_id = ? AND deleted_at IS NULL ORDER BY start_time, id",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?)
}

#[derive(sqlx::FromRow)]
pub(super) struct TranscriptRow {
    pub text: String,
    pub timeline: Option<String>,
    pub timeline_source: Option<String>,
    pub source: String,
}

#[derive(sqlx::FromRow)]
pub(super) struct SummaryRow {
    pub summary: Option<String>,
    pub action_items: Option<String>,
    pub key_points: Option<String>,
    pub provider: String,
    pub model: String,
    pub created_at: i64,
}

/// The newest transcript of each recording, keyed by recording id.
pub(super) async fn latest_transcripts(
    db: &SqlitePool,
    user_id: &str,
) -> ApiResult<HashMap<String, TranscriptRow>> {
    #[derive(sqlx::FromRow)]
    struct Keyed {
        recording_id: String,
        #[sqlx(flatten)]
        row: TranscriptRow,
    }
    let rows: Vec<Keyed> = sqlx::query_as(
        "SELECT recording_id, text, timeline, timeline_source, source FROM transcriptions \
         WHERE user_id = ? ORDER BY created_at ASC",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;
    // Ascending order: a later row replaces an earlier one.
    Ok(rows.into_iter().map(|k| (k.recording_id, k.row)).collect())
}

/// The AI summary of each recording, keyed by recording id.
pub(super) async fn summaries(
    db: &SqlitePool,
    user_id: &str,
) -> ApiResult<HashMap<String, SummaryRow>> {
    #[derive(sqlx::FromRow)]
    struct Keyed {
        recording_id: String,
        #[sqlx(flatten)]
        row: SummaryRow,
    }
    let rows: Vec<Keyed> = sqlx::query_as(
        "SELECT recording_id, summary, action_items, key_points, provider, model, created_at \
         FROM ai_enhancements WHERE user_id = ?",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(|k| (k.recording_id, k.row)).collect())
}

/// A decrypted AI summary.
pub(super) struct Summary {
    pub summary: Option<String>,
    pub action_items: Vec<String>,
    pub key_points: Vec<String>,
}

pub(super) fn decrypt_summary(key: &FieldKey, row: &SummaryRow) -> ApiResult<Summary> {
    let summary = row
        .summary
        .as_deref()
        .map(|s| key.decrypt(s))
        .transpose()
        .map_err(AppError::internal)?;
    Ok(Summary {
        summary,
        action_items: decrypt_list(key, row.action_items.as_deref())?,
        key_points: decrypt_list(key, row.key_points.as_deref())?,
    })
}

fn decrypt_list(key: &FieldKey, raw: Option<&str>) -> ApiResult<Vec<String>> {
    let Some(raw) = raw else {
        return Ok(Vec::new());
    };
    let value: Value = serde_json::from_str(raw).map_err(AppError::internal)?;
    let value = key.decrypt_json(&value).map_err(AppError::internal)?;
    Ok(value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default())
}

pub(super) fn summary_json(s: &Summary) -> Value {
    json!({ "summary": s.summary, "actionItems": s.action_items, "keyPoints": s.key_points })
}
