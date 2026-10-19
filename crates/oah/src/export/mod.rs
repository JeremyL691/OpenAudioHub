//! Export: `GET /api/export` and the desktop auto export of new recordings.
//! Behavior is described in spec/export.md.

pub(crate) mod auto;
mod text;

use std::collections::HashMap;

use axum::Router;
use axum::routing::get;
use serde_json::{Value, json};
use sqlx::SqlitePool;

use crate::AppState;
use crate::crypto::FieldKey;
use crate::error::{ApiResult, AppError};

pub fn router() -> Router<AppState> {
    Router::new().route("/api/export", get(text::get))
}

/// Starts the auto export loop. It only writes files in the desktop build.
pub fn spawn(state: &AppState) {
    auto::spawn(state);
}

#[derive(sqlx::FromRow)]
pub(super) struct RecRow {
    pub id: String,
    pub filename: String,
    pub duration: i64,
    pub start_time: i64,
    pub filesize: i64,
}

/// Live (not deleted) recordings of a user.
pub(super) async fn live_recordings(db: &SqlitePool, user_id: &str) -> ApiResult<Vec<RecRow>> {
    Ok(sqlx::query_as(
        "SELECT id, filename, duration, start_time, filesize FROM recordings \
         WHERE user_id = ? AND deleted_at IS NULL ORDER BY start_time, id",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?)
}

#[derive(sqlx::FromRow)]
pub(super) struct TranscriptRow {
    pub text: String,
}

#[derive(sqlx::FromRow)]
pub(super) struct SummaryRow {
    pub summary: Option<String>,
    pub action_items: Option<String>,
    pub key_points: Option<String>,
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
        "SELECT recording_id, text FROM transcriptions \
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
        "SELECT recording_id, summary, action_items, key_points \
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
