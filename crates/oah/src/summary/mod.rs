//! Summaries and titles (spec/ai.md "Summaries", "Title generation"; spec/workers.md "Auto-summary").
//! A manual summary runs as a `summary` job; concurrent requests wait on that one job.

pub mod followup;
mod generate;
mod prompts;
mod text;
mod title;

use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{Map, Value, json};

use crate::auth::CurrentUser;
use crate::db::now_ms;
use crate::error::{ApiResult, AppError};
use crate::jobs::{self, Job, NewJob};
use crate::time::iso;
use crate::{AppState, ai, routes};
use generate::Plan;

pub(crate) const AUTO_LIMIT_DEFAULT: u64 = 60;
pub(crate) const HOUR_MS: i64 = 3_600_000;
const POLL: Duration = Duration::from_millis(300);
const WORKERS: usize = 2;

pub fn router() -> Router<AppState> {
    Router::new().route(
        "/api/recordings/{id}/summary",
        get(get_summary).post(post_summary).delete(delete_summary),
    )
}

/// Starts the summary job workers.
pub fn spawn(state: &AppState) {
    let worker = state.clone();
    jobs::spawn_workers(
        state.db.clone(),
        state.wakeup.clone(),
        "summary",
        WORKERS,
        1,
        move |job: Job| {
            let state = worker.clone();
            async move { generate::run_job(&state, job).await }
        },
    );
    followup::spawn(state);
}

/// Queues an automatic summary for a transcript, if the user wants one and this transcript does
/// not have one yet.
///
/// This is the entry point the follow-up job uses, so the run is tied to the transcript it was
/// asked for: the plan carries the transcript id, and the worker skips the run when a newer
/// transcript replaced it. A transcript that already produced a summary does not get a second
/// automatic one.
pub async fn queue_auto_for(
    state: &AppState,
    user_id: &str,
    recording_id: &str,
    transcript_id: &str,
) -> ApiResult<bool> {
    let settings = routes::settings::effective(state, user_id).await?;
    if settings.get("autoSummarize") != Some(&Value::Bool(true)) {
        return Ok(false);
    }
    if has_summary_for(state, recording_id, transcript_id).await? {
        return Ok(false);
    }
    let preset = settings
        .get("autoSummarizePreset")
        .and_then(Value::as_str)
        .filter(|p| !p.is_empty());
    let mut plan = generate::plan(&settings, preset, None, "");
    plan.trigger = Some("auto".into());
    plan.transcript_id = Some(transcript_id.to_owned());
    let payload = serde_json::to_value(&plan).map_err(AppError::internal)?;
    // Keyed by the transcript, so a recording transcribed again does not reuse an older
    // transcript's queued run: that run would end as stale and the new transcript would never be
    // summarised. The queue allows one keyed run per transcript and any number of manual runs.
    jobs::enqueue_in(
        &state.db,
        NewJob {
            kind: "summary",
            user_id: Some(user_id),
            recording_id: Some(recording_id),
            payload,
        },
        Some(&summary_key(transcript_id)),
    )
    .await?;
    state.wakeup.notify();
    Ok(true)
}

/// The key an automatic summary for this transcript is queued under.
fn summary_key(transcript_id: &str) -> String {
    format!("summary:{transcript_id}")
}

/// Whether the summary that exists was written from this transcript.
///
/// A summary has no transcript id of its own, so it cannot prove which transcript it came from.
/// The save step deletes the summary whenever a new transcript replaces an old one, which is why
/// any summary on a recording whose transcript is still this one was written from it, and why a
/// summary that exists is enough to skip a second automatic run.
async fn has_summary_for(
    state: &AppState,
    recording_id: &str,
    transcript_id: &str,
) -> ApiResult<bool> {
    let still_current: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM transcriptions WHERE id = ? AND recording_id = ?)",
    )
    .bind(transcript_id)
    .bind(recording_id)
    .fetch_one(&state.db)
    .await?;
    if !still_current {
        return Ok(true);
    }
    has_content(state, recording_id).await
}

/// Whether a recording has a summary the UI can show: text, key points or action items.
pub async fn has_content(state: &AppState, recording_id: &str) -> ApiResult<bool> {
    let row: Option<i64> =
        sqlx::query_scalar("SELECT has_content FROM ai_enhancements WHERE recording_id = ?")
            .bind(recording_id)
            .fetch_optional(&state.db)
            .await?;
    Ok(row == Some(1))
}

fn recording_not_found() -> AppError {
    AppError::not_found("RECORDING_NOT_FOUND", "Recording not found")
}

fn gone() -> AppError {
    AppError::new(StatusCode::GONE, "NOT_FOUND", generate::DELETED_MESSAGE)
}

/// Maps a failed job's stored error to the response the request gets.
fn failure(code: Option<String>, message: Option<String>) -> AppError {
    let message = message.unwrap_or_else(|| "Something went wrong".to_owned());
    let (status, code) = match code.as_deref() {
        Some("NOT_FOUND") => return gone(),
        Some("INVALID_INPUT") => (StatusCode::BAD_REQUEST, "INVALID_INPUT"),
        Some("AI_PROVIDER_NOT_CONFIGURED") => {
            (StatusCode::BAD_REQUEST, "AI_PROVIDER_NOT_CONFIGURED")
        }
        Some("AI_PROVIDER_API_ERROR") => (StatusCode::BAD_GATEWAY, "AI_PROVIDER_API_ERROR"),
        Some("UPSTREAM_BAD_RESPONSE") => (StatusCode::BAD_GATEWAY, "UPSTREAM_BAD_RESPONSE"),
        _ => return AppError::internal(message),
    };
    AppError::new(status, code, message)
}

#[derive(sqlx::FromRow)]
struct SummaryRow {
    summary: Option<String>,
    action_items: Option<String>,
    key_points: Option<String>,
    provider: String,
    model: String,
    prompt_id: Option<String>,
    language: Option<String>,
    created_at: i64,
}

async fn load_row(state: &AppState, user_id: &str, id: &str) -> ApiResult<Option<SummaryRow>> {
    let row = sqlx::query_as::<_, SummaryRow>(
        "SELECT summary, action_items, key_points, provider, model, prompt_id, language, created_at
         FROM ai_enhancements WHERE recording_id = ? AND user_id = ?",
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?;
    Ok(row)
}

/// Opens the encrypted fields of a saved summary into the response shape.
fn view(state: &AppState, row: SummaryRow) -> ApiResult<Value> {
    let summary = match row.summary.as_deref() {
        Some(s) => Some(
            state
                .config
                .field_key
                .decrypt(s)
                .map_err(AppError::internal)?,
        ),
        None => None,
    };
    Ok(json!({
        "summary": summary,
        "keyPoints": open_list(state, row.key_points.as_deref())?,
        "actionItems": open_list(state, row.action_items.as_deref())?,
        "provider": row.provider,
        "model": row.model,
        "promptId": row.prompt_id,
        "language": row.language,
        "createdAt": iso(row.created_at),
    }))
}

fn open_list(state: &AppState, stored: Option<&str>) -> ApiResult<Vec<String>> {
    let Some(raw) = stored else {
        return Ok(Vec::new());
    };
    let envelope: Value = serde_json::from_str(raw).map_err(AppError::internal)?;
    let opened = state
        .config
        .field_key
        .decrypt_json(&envelope)
        .map_err(AppError::internal)?;
    Ok(opened
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default())
}

async fn get_summary(
    user: CurrentUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    generate::duration_of(&state, &user.id, &id)
        .await?
        .ok_or_else(recording_not_found)?;
    let (status, error) = run_state(&state, &user.id, &id).await?;
    let mut out = match load_row(&state, &user.id, &id).await? {
        Some(row) => view(&state, row)?,
        None => json!({ "summary": null }),
    };
    out["generating"] = json!(matches!(status, "queued" | "running"));
    out["status"] = json!(status);
    if let Some(message) = error {
        out["error"] = json!(message);
    }
    Ok(Json(out))
}

/// The run state of a recording's summary: the active or latest job, else whether content exists.
///
/// The UI uses this instead of guessing from the presence of a row, so "ready" always means the
/// detail pane has something to show.
async fn run_state(
    state: &AppState,
    user_id: &str,
    id: &str,
) -> ApiResult<(&'static str, Option<String>)> {
    let job: Option<(String, Option<String>)> = sqlx::query_as(
        "SELECT state, error_message FROM jobs WHERE kind = 'summary' AND recording_id = ? AND user_id = ? \
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?;
    let content = has_content(state, id).await?;
    if let Some((job_state, message)) = job {
        match job_state.as_str() {
            "queued" => return Ok(("queued", None)),
            "running" => return Ok(("running", None)),
            // A failed re-run keeps the previous summary, so the pane still has something to show.
            // The failure is only the state when there is nothing else.
            "failed" if !content => return Ok(("failed", message)),
            _ => {}
        }
    }
    Ok(if content {
        ("completed", None)
    } else {
        ("idle", None)
    })
}

/// The request body: an empty body or a JSON object.
fn request_fields(body: &Bytes) -> ApiResult<Map<String, Value>> {
    if body.iter().all(u8::is_ascii_whitespace) {
        return Ok(Map::new());
    }
    match serde_json::from_slice::<Value>(body) {
        Ok(Value::Object(map)) => Ok(map),
        _ => Err(AppError::bad_request(
            "INVALID_INPUT",
            "Request body must be a JSON object",
        )),
    }
}

/// Waits for the summary job to finish and returns the plan it ran with.
async fn wait_for(state: &AppState, job_id: &str) -> ApiResult<Plan> {
    loop {
        let row = sqlx::query_as::<_, (String, Option<String>, Option<String>, String)>(
            "SELECT state, error_code, error_message, payload FROM jobs WHERE id = ?",
        )
        .bind(job_id)
        .fetch_optional(&state.db)
        .await?;
        match row {
            None => return Err(gone()),
            Some((s, _, _, payload)) if s == "done" => {
                return serde_json::from_str::<Plan>(&payload).map_err(AppError::internal);
            }
            Some((s, code, message, _)) if s != "queued" && s != "running" => {
                return Err(failure(code, message));
            }
            Some(_) => tokio::time::sleep(POLL).await,
        }
    }
}

async fn post_summary(
    user: CurrentUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    let fields = request_fields(&body)?;
    generate::duration_of(&state, &user.id, &id)
        .await?
        .ok_or_else(recording_not_found)?;
    let source: String = fields
        .get("source")
        .and_then(Value::as_str)
        .unwrap_or("")
        .chars()
        .take(20)
        .collect();
    if generate::load_transcript(&state, &user.id, &id, &source)
        .await?
        .is_none()
    {
        return Err(AppError::bad_request(
            "INVALID_INPUT",
            "Transcribe the recording first",
        ));
    }
    if ai::enhancement_provider(&state, &user.id).await?.is_none() {
        return Err(AppError::bad_request(
            "AI_PROVIDER_NOT_CONFIGURED",
            "No AI provider can make summaries.",
        ));
    }
    let settings = routes::settings::effective(&state, &user.id).await?;
    let preset = fields
        .get("preset")
        .and_then(Value::as_str)
        .filter(|p| !p.is_empty());
    let language = fields.get("language").and_then(Value::as_str);
    let plan = generate::plan(&settings, preset, language, &source);
    let payload = serde_json::to_value(&plan).map_err(AppError::internal)?;
    // A request made while a run is active joins that run: its plan is the one the job holds.
    let job_id = jobs::enqueue(
        &state.db,
        NewJob {
            kind: "summary",
            user_id: Some(&user.id),
            recording_id: Some(&id),
            payload,
        },
    )
    .await?;
    state.wakeup.notify();
    let ran = wait_for(&state, &job_id).await?;
    let row = load_row(&state, &user.id, &id).await?.ok_or_else(gone)?;
    let mut out = view(&state, row)?;
    out["promptFallback"] = json!(ran.prompt_fallback);
    Ok(Json(out))
}

async fn delete_summary(
    user: CurrentUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let removed = sqlx::query("DELETE FROM ai_enhancements WHERE recording_id = ? AND user_id = ?")
        .bind(&id)
        .bind(&user.id)
        .execute(&state.db)
        .await?
        .rows_affected();
    if removed > 0 {
        sqlx::query("UPDATE recordings SET updated_at = ? WHERE id = ? AND user_id = ?")
            .bind(now_ms())
            .bind(&id)
            .bind(&user.id)
            .execute(&state.db)
            .await?;
    }
    Ok(Json(json!({ "success": true })))
}
