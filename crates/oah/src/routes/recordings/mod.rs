//! Recording routes: list, detail, edit, delete, star, upload, audio, peaks, batch download, merge.
//! Behavior is described in spec/recordings.md.

pub mod media;
pub mod search;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use axum::body::{Body, Bytes};
use axum::extract::multipart::MultipartError;
use axum::extract::{DefaultBodyLimit, Multipart, Path as UrlPath, Query, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use futures_util::StreamExt;
use serde_json::{Value, json};
use sqlx::SqlitePool;
use tokio::io::{AsyncRead, AsyncWriteExt};
use tokio::process::Command;
use tokio_util::io::ReaderStream;

use crate::auth::CurrentUser;
use crate::crypto::FieldKey;
use crate::db::now_ms;
use crate::error::{ApiResult, AppError};
use crate::storage::{LocalFile, StorageError};
use crate::{AppState, ids, time};

const MAX_UPLOAD_BYTES: u64 = 500 * 1024 * 1024;
const ACCEPTED: [&str; 9] = [
    "mp3", "mp4", "m4a", "wav", "ogg", "opus", "webm", "aac", "flac",
];
const MAX_MERGE_MS: i64 = 24 * 3600 * 1000;
const CACHE_IMMUTABLE: &str = "private, max-age=31536000, immutable";
const PRIVATE: &str = "private, no-store";

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/recordings", get(list))
        .route("/api/recordings/search", get(search::search))
        .route("/api/recordings/download", get(download))
        .route(
            "/api/recordings/upload",
            post(upload).layer(DefaultBodyLimit::disable()),
        )
        .route("/api/recordings/merge", post(merge))
        .route(
            "/api/recordings/title-repair",
            get(title_repair_preview).post(title_repair_apply),
        )
        .route(
            "/api/recordings/{id}",
            get(detail).patch(rename).delete(remove),
        )
        .route("/api/recordings/{id}/star", put(star))
        .route("/api/recordings/{id}/audio", get(audio))
        .route("/api/recordings/{id}/peaks", post(peaks))
}

const COLUMNS: &str = "id, user_id, device_sn, plaud_file_id, filename, duration, start_time, end_time, \
    filesize, file_md5, storage_type, storage_path, auto_export_path, downloaded_at, plaud_version, \
    timezone, zonemins, scene, is_trash, waveform_peaks, starred_at, created_at, updated_at";

#[derive(sqlx::FromRow)]
struct Row {
    id: String,
    user_id: String,
    device_sn: String,
    plaud_file_id: String,
    filename: String,
    duration: i64,
    start_time: i64,
    end_time: i64,
    filesize: i64,
    file_md5: String,
    storage_type: String,
    storage_path: String,
    auto_export_path: Option<String>,
    downloaded_at: Option<i64>,
    plaud_version: String,
    timezone: Option<i64>,
    zonemins: Option<i64>,
    scene: Option<i64>,
    is_trash: bool,
    waveform_peaks: Option<String>,
    starred_at: Option<i64>,
    created_at: i64,
    updated_at: i64,
}

#[derive(sqlx::FromRow)]
struct TranscriptRow {
    id: String,
    recording_id: String,
    user_id: String,
    text: String,
    detected_language: Option<String>,
    transcription_type: String,
    provider: String,
    model: String,
    timeline: Option<String>,
    timeline_source: Option<String>,
    source: String,
    created_at: i64,
}

fn row_json(key: &FieldKey, r: Row) -> ApiResult<Value> {
    let filename = key.decrypt(&r.filename).map_err(AppError::internal)?;
    let peaks = r
        .waveform_peaks
        .as_deref()
        .map(serde_json::from_str::<Value>)
        .transpose()
        .map_err(AppError::internal)?;
    Ok(json!({
        "id": r.id,
        "userId": r.user_id,
        "deviceSn": r.device_sn,
        "plaudFileId": r.plaud_file_id,
        "filename": filename,
        "duration": r.duration,
        "startTime": time::iso(r.start_time),
        "endTime": time::iso(r.end_time),
        "filesize": r.filesize,
        "fileMd5": r.file_md5,
        "storageType": r.storage_type,
        "storagePath": r.storage_path,
        // Stored encrypted; plain values pass through.
        "autoExportPath": r
            .auto_export_path
            .as_deref()
            .map(|p| key.decrypt(p).unwrap_or_else(|_| p.to_owned())),
        "downloadedAt": r.downloaded_at.map(time::iso),
        "plaudVersion": r.plaud_version,
        "timezone": r.timezone,
        "zonemins": r.zonemins,
        "scene": r.scene,
        "isTrash": r.is_trash,
        "waveformPeaks": peaks,
        "deletedAt": Value::Null,
        "starredAt": r.starred_at.map(time::iso),
        "createdAt": time::iso(r.created_at),
        "updatedAt": time::iso(r.updated_at),
    }))
}

fn transcript_json(key: &FieldKey, t: TranscriptRow) -> ApiResult<Value> {
    let text = key.decrypt(&t.text).map_err(AppError::internal)?;
    let timeline = t
        .timeline
        .as_deref()
        .map(serde_json::from_str::<Value>)
        .transpose()
        .map_err(AppError::internal)?
        .map(|v| key.decrypt_json(&v).map_err(AppError::internal))
        .transpose()?;
    Ok(json!({
        "id": t.id,
        "recordingId": t.recording_id,
        "userId": t.user_id,
        "text": text,
        "detectedLanguage": t.detected_language,
        "transcriptionType": t.transcription_type,
        "provider": t.provider,
        "model": t.model,
        "timeline": timeline,
        "timelineSource": t.timeline_source,
        "source": t.source,
        "createdAt": time::iso(t.created_at),
    }))
}

async fn list_rows(db: &SqlitePool, key: &FieldKey, user_id: &str) -> ApiResult<Vec<Value>> {
    let sql = format!(
        "SELECT {COLUMNS} FROM recordings WHERE user_id = ? AND deleted_at IS NULL \
         ORDER BY start_time DESC, id DESC"
    );
    let rows = sqlx::query_as::<_, Row>(&sql)
        .bind(user_id)
        .fetch_all(db)
        .await?;
    // Status for the list pills and filters, in three queries rather than one per row.
    let transcribed: HashSet<String> =
        sqlx::query_scalar("SELECT DISTINCT recording_id FROM transcriptions WHERE user_id = ?")
            .bind(user_id)
            .fetch_all(db)
            .await?
            .into_iter()
            .collect();
    let summarized: HashSet<String> = sqlx::query_scalar(
        "SELECT recording_id FROM ai_enhancements WHERE user_id = ? AND has_content = 1",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?
    .into_iter()
    .collect();
    let active: HashMap<String, (String, f64)> = sqlx::query_as::<_, (String, String, f64)>(
        "SELECT recording_id, kind, progress FROM jobs WHERE user_id = ? AND recording_id IS NOT NULL \
         AND state IN ('queued', 'running') AND kind IN ('transcribe', 'pipeline', 'summary')",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?
    .into_iter()
    .map(|(id, kind, progress)| (id, (kind, progress)))
    .collect();
    rows.into_iter()
        .map(|r| {
            let id = r.id.clone();
            let mut v = row_json(key, r)?;
            v["hasTranscript"] = transcribed.contains(&id).into();
            v["hasSummary"] = summarized.contains(&id).into();
            v["processing"] = active.get(&id).map_or(
                Value::Null,
                |(kind, progress)| json!({ "kind": kind, "progress": progress }),
            );
            Ok(v)
        })
        .collect()
}

async fn find(state: &AppState, user_id: &str, id: &str) -> ApiResult<Row> {
    let sql = format!(
        "SELECT {COLUMNS} FROM recordings WHERE id = ? AND user_id = ? AND deleted_at IS NULL"
    );
    sqlx::query_as::<_, Row>(&sql)
        .bind(id)
        .bind(user_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(not_found)
}

/// Live recordings among `ids`, in no particular order.
async fn fetch_many(db: &SqlitePool, user_id: &str, ids: &[String]) -> ApiResult<Vec<Row>> {
    let marks = vec!["?"; ids.len()].join(", ");
    let sql = format!(
        "SELECT {COLUMNS} FROM recordings WHERE user_id = ? AND deleted_at IS NULL AND id IN ({marks})"
    );
    let mut query = sqlx::query_as::<_, Row>(&sql).bind(user_id);
    for id in ids {
        query = query.bind(id.as_str());
    }
    Ok(query.fetch_all(db).await?)
}

/// Keeps the requested order and drops ids that were not found.
fn ordered(rows: Vec<Row>, wanted: &[String]) -> Vec<Row> {
    let mut by_id: HashMap<String, Row> = rows.into_iter().map(|r| (r.id.clone(), r)).collect();
    wanted.iter().filter_map(|id| by_id.remove(id)).collect()
}

fn title_of(state: &AppState, row: &Row) -> ApiResult<String> {
    state
        .config
        .field_key
        .decrypt(&row.filename)
        .map_err(AppError::internal)
}

fn ext_of(storage_path: &str) -> String {
    Path::new(storage_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

pub(crate) fn mime_for(ext: &str) -> &'static str {
    match ext {
        "mp4" | "m4a" => "audio/mp4",
        "wav" => "audio/wav",
        "ogg" | "opus" => "audio/ogg",
        "webm" => "audio/webm",
        "aac" => "audio/aac",
        "flac" => "audio/flac",
        _ => "audio/mpeg",
    }
}

fn not_found() -> AppError {
    AppError::not_found("RECORDING_NOT_FOUND", "Recording not found")
}

fn invalid(message: &'static str) -> AppError {
    AppError::bad_request("INVALID_INPUT", message)
}

fn multipart_error(e: MultipartError) -> AppError {
    AppError::new(e.status(), "INVALID_INPUT", e.body_text())
}

fn valid_id(s: &str) -> bool {
    (1..=64).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// A title as a file name: listed symbols become "-", whitespace runs collapse, at most 200 characters.
fn file_title(title: &str, fallback: &str) -> String {
    let mapped: String = title
        .chars()
        .map(|c| if "/\\:*?\"<>|".contains(c) { '-' } else { c })
        .collect();
    let collapsed = mapped.split_whitespace().collect::<Vec<_>>().join(" ");
    let capped: String = collapsed.chars().take(200).collect();
    if capped.is_empty() {
        fallback.to_owned()
    } else {
        capped
    }
}

/// `attachment` disposition with an ASCII fallback name and an RFC 5987 UTF-8 name.
fn attachment(name: &str) -> String {
    let ascii: String = name
        .chars()
        .map(|c| {
            if c.is_ascii() && !c.is_ascii_control() {
                c
            } else {
                '_'
            }
        })
        .collect();
    let encoded: String = name
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect();
    format!("attachment; filename=\"{ascii}\"; filename*=UTF-8''{encoded}")
}

/// Name for an archive entry; a repeated name (ignoring case) gets " (2)", " (3)", and so on.
fn unique_name(taken: &mut HashSet<String>, base: &str, ext: &str) -> String {
    let mut n = 1;
    loop {
        let name = if n == 1 {
            format!("{base}.{ext}")
        } else {
            format!("{base} ({n}).{ext}")
        };
        if taken.insert(name.to_lowercase()) {
            return name;
        }
        n += 1;
    }
}

#[derive(Debug, PartialEq)]
enum Span {
    Whole,
    /// Inclusive first and last byte.
    Part(u64, u64),
    Unsatisfiable,
}

/// Parses `bytes=<start>-<end>` and `bytes=<start>-`. Other forms are ignored, so the whole file is sent.
fn parse_range(header: Option<&str>, size: u64) -> Span {
    let Some(spec) = header.and_then(|h| h.strip_prefix("bytes=")) else {
        return Span::Whole;
    };
    let Some((start, end)) = spec.split_once('-') else {
        return Span::Whole;
    };
    let Ok(start) = start.parse::<u64>() else {
        return Span::Whole;
    };
    let end = if end.is_empty() {
        size.saturating_sub(1)
    } else {
        match end.parse::<u64>() {
            Ok(end) => end,
            Err(_) => return Span::Whole,
        }
    };
    if start >= size || start > end || end >= size {
        Span::Unsatisfiable
    } else {
        Span::Part(start, end)
    }
}

/// Streams a reader in chunks. `guard` lives as long as the body, so a child process or temp files end with it.
fn stream_with<R, G>(reader: R, guard: G) -> Body
where
    R: AsyncRead + Send + 'static,
    G: Send + 'static,
{
    Body::from_stream(
        ReaderStream::with_capacity(reader, 64 * 1024).map(move |chunk| {
            let _keep = &guard;
            chunk
        }),
    )
}

/// A response with a status, headers from a list, and a streamed body.
fn respond(status: StatusCode, head: Vec<(HeaderName, String)>, body: Body) -> Response {
    let mut res = Response::new(body);
    *res.status_mut() = status;
    for (name, value) in head {
        if let Ok(value) = HeaderValue::try_from(value) {
            res.headers_mut().insert(name, value);
        }
    }
    res
}

fn audio_headers(mime: &str, len: u64) -> Vec<(HeaderName, String)> {
    vec![
        (header::CONTENT_TYPE, mime.to_owned()),
        (header::CONTENT_LENGTH, len.to_string()),
        (header::ACCEPT_RANGES, "bytes".to_owned()),
        (header::CACHE_CONTROL, CACHE_IMMUTABLE.to_owned()),
    ]
}

/// Files to remove when this value is dropped. Clear the list to keep them.
#[derive(Default)]
struct Scratch(Vec<PathBuf>);

impl Drop for Scratch {
    fn drop(&mut self) {
        for path in &self.0 {
            let _ = std::fs::remove_file(path);
        }
    }
}

struct NewRecording<'a> {
    id: &'a str,
    user_id: &'a str,
    plaud_file_id: &'a str,
    title: &'a str,
    duration: i64,
    start: i64,
    filesize: i64,
    file_md5: &'a str,
    storage_type: &'a str,
    storage_path: &'a str,
    title_source: &'a str,
    auto_export_eligible: bool,
}

async fn insert(db: &SqlitePool, key: &FieldKey, r: NewRecording<'_>) -> ApiResult<()> {
    let now = now_ms();
    sqlx::query(
        "INSERT INTO recordings (id, user_id, device_sn, plaud_file_id, filename, duration, start_time, \
         end_time, filesize, file_md5, storage_type, storage_path, downloaded_at, plaud_version, is_trash, \
         created_at, updated_at, title_source, auto_export_eligible) VALUES (?, ?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '1', 0, ?, ?, ?, ?)",
    )
    .bind(r.id)
    .bind(r.user_id)
    .bind(r.plaud_file_id)
    .bind(key.encrypt(r.title))
    .bind(r.duration)
    .bind(r.start)
    .bind(r.start + r.duration)
    .bind(r.filesize)
    .bind(r.file_md5)
    .bind(r.storage_type)
    .bind(r.storage_path)
    .bind(now)
    .bind(now)
    .bind(now)
    .bind(r.title_source)
    .bind(r.auto_export_eligible)
    .execute(db)
    .await?;
    Ok(())
}

// ---- list, detail, edit, delete, star ----

async fn list(State(state): State<AppState>, user: CurrentUser) -> ApiResult<Json<Value>> {
    let recordings = list_rows(&state.db, &state.config.field_key, &user.id).await?;
    Ok(Json(json!({ "recordings": recordings })))
}

async fn detail(
    State(state): State<AppState>,
    user: CurrentUser,
    UrlPath(id): UrlPath<String>,
) -> ApiResult<Json<Value>> {
    let row = find(&state, &user.id, &id).await?;
    let transcript = sqlx::query_as::<_, TranscriptRow>(
        "SELECT id, recording_id, user_id, text, detected_language, transcription_type, provider, model, timeline, timeline_source, \
         source, created_at FROM transcriptions WHERE recording_id = ? AND user_id = ? \
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(id.as_str())
    .bind(user.id.as_str())
    .fetch_optional(&state.db)
    .await?;
    let transcription = match transcript {
        Some(t) => transcript_json(&state.config.field_key, t)?,
        None => Value::Null,
    };
    let recording = row_json(&state.config.field_key, row)?;
    Ok(Json(
        json!({ "recording": recording, "transcription": transcription }),
    ))
}

async fn rename(
    State(state): State<AppState>,
    user: CurrentUser,
    UrlPath(id): UrlPath<String>,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    let raw = serde_json::from_slice::<Value>(&body)
        .ok()
        .and_then(|v| v.get("filename").and_then(Value::as_str).map(str::to_owned));
    let raw =
        raw.ok_or_else(|| invalid("filename must be a string").detail("field", "filename"))?;
    let name = raw
        .chars()
        .filter(|c| *c >= ' ' && *c != '\u{7f}')
        .collect::<String>();
    let name = name.trim().to_owned();
    let len = name.chars().count();
    if len == 0 {
        return Err(invalid("Name cannot be empty").detail("field", "filename"));
    }
    if len > 200 {
        return Err(invalid("Name must be 200 characters or fewer")
            .detail("field", "filename")
            .detail("maxLength", 200));
    }
    // A name the user typed is theirs, so a later sync must not replace it.
    let res = sqlx::query(
        "UPDATE recordings SET filename = ?, title_source = 'manual', updated_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
    )
    .bind(state.config.field_key.encrypt(&name))
    .bind(now_ms())
    .bind(id.as_str())
    .bind(user.id.as_str())
    .execute(&state.db)
    .await?;
    if res.rows_affected() == 0 {
        return Err(not_found());
    }
    crate::webhooks::emit_soft(&state, &user.id, &id, "recording.updated", None).await;
    Ok(Json(json!({ "filename": name })))
}

/// Removes the audio first (a storage failure leaves everything unchanged and the client may
/// retry, spec/recordings.md), then marks the row deleted.
async fn remove(
    State(state): State<AppState>,
    user: CurrentUser,
    UrlPath(id): UrlPath<String>,
) -> ApiResult<Json<Value>> {
    let row = find(&state, &user.id, &id).await?;
    if let Err(e) = state
        .storage
        .delete(&row.storage_type, &row.storage_path)
        .await
    {
        let mut err = AppError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "STORAGE_ERROR",
            "Failed to delete recording audio. Please retry.",
        );
        err.source = Some(e.to_string());
        return Err(err);
    }
    let now = now_ms();
    let mut tx = state.db.begin().await?;
    sqlx::query("DELETE FROM transcriptions WHERE recording_id = ?")
        .bind(id.as_str())
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM ai_enhancements WHERE recording_id = ?")
        .bind(id.as_str())
        .execute(&mut *tx)
        .await?;
    let res = sqlx::query(
        "UPDATE recordings SET deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
    )
    .bind(now)
    .bind(now)
    .bind(id.as_str())
    .bind(user.id.as_str())
    .execute(&mut *tx)
    .await?;
    if res.rows_affected() == 0 {
        return Err(not_found());
    }
    tx.commit().await?;
    crate::webhooks::emit_soft(&state, &user.id, &id, "recording.deleted", None).await;
    Ok(Json(json!({ "success": true })))
}

async fn star(
    State(state): State<AppState>,
    user: CurrentUser,
    UrlPath(id): UrlPath<String>,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    let starred = serde_json::from_slice::<Value>(&body)
        .ok()
        .and_then(|v| v.get("starred").and_then(Value::as_bool))
        .ok_or_else(|| invalid("starred must be a boolean").detail("field", "starred"))?;
    let now = now_ms();
    let res = sqlx::query(
        "UPDATE recordings SET starred_at = CASE WHEN ? THEN COALESCE(starred_at, ?) END, updated_at = ? \
         WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
    )
    .bind(starred)
    .bind(now)
    .bind(now)
    .bind(id.as_str())
    .bind(user.id.as_str())
    .execute(&state.db)
    .await?;
    if res.rows_affected() == 0 {
        return Err(not_found());
    }
    Ok(Json(json!({ "id": id, "starred": starred })))
}

// ---- title repair ----

/// One recording whose stored date-time title can become a plain date.
fn repair_json(id: &str, current: &str, suggested: &str, start: i64) -> Value {
    json!({
        "id": id,
        "filename": current,
        "suggestedFilename": suggested,
        "startTime": time::iso(start),
    })
}

/// Recordings whose title looks like a date-time title this app wrote before it used plain dates.
///
/// `title_source` is not enough on its own: rows written before it existed carry `unknown`, and a
/// date-time title is not something a user types. Candidates are listed for the user to pick from,
/// and are never applied automatically.
async fn title_repair_preview(
    State(state): State<AppState>,
    user: CurrentUser,
) -> ApiResult<Json<Value>> {
    let rows: Vec<(String, String, i64, String)> = sqlx::query_as(
        "SELECT id, filename, start_time, title_source FROM recordings WHERE user_id = ? AND deleted_at IS NULL \
         AND title_source != 'manual' AND title_source != 'ai' AND start_time > 0 ORDER BY start_time DESC",
    )
    .bind(&user.id)
    .fetch_all(&state.db)
    .await?;
    let mut candidates = Vec::new();
    for (id, encrypted, start, _) in rows {
        let Ok(current) = state.config.field_key.decrypt(&encrypted) else {
            continue;
        };
        let offset = local_offset_at(start).await;
        if let Some(day) = crate::plaud::sync::repair_candidate(&current, start, offset) {
            candidates.push(repair_json(&id, &current, &day, start));
        }
    }
    Ok(Json(json!({ "candidates": candidates })))
}

/// Applies the picked titles. Each pick names the title it expects, so a recording renamed since
/// the preview is skipped rather than overwritten.
async fn title_repair_apply(
    State(state): State<AppState>,
    user: CurrentUser,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Pick {
        id: String,
        expected_filename: String,
    }
    let picks: Vec<Pick> = serde_json::from_slice::<Value>(&body)
        .ok()
        .and_then(|v| v.get("picks").and_then(Value::as_array).cloned())
        .map(|list| {
            list.into_iter()
                .filter_map(|item| serde_json::from_value(item).ok())
                .collect()
        })
        .ok_or_else(|| invalid("picks must be a list of { id, expectedFilename }"))?;
    if picks.is_empty() {
        return Ok(Json(json!({ "renamed": [], "skipped": [] })));
    }
    let mut renamed = Vec::new();
    let mut skipped = Vec::new();
    for pick in picks {
        let row: Option<(String, i64)> = sqlx::query_as(
            "SELECT filename, start_time FROM recordings WHERE id = ? AND user_id = ? AND deleted_at IS NULL \
             AND title_source != 'manual' AND title_source != 'ai'",
        )
        .bind(&pick.id)
        .bind(&user.id)
        .fetch_optional(&state.db)
        .await?;
        let Some((encrypted, start)) = row else {
            skipped.push(json!({ "id": pick.id, "reason": "not found" }));
            continue;
        };
        let current = state
            .config
            .field_key
            .decrypt(&encrypted)
            .map_err(AppError::internal)?;
        if current != pick.expected_filename {
            skipped.push(json!({ "id": pick.id, "reason": "renamed" }));
            continue;
        }
        let offset = local_offset_at(start).await;
        let Some(day) = crate::plaud::sync::repair_candidate(&current, start, offset) else {
            skipped.push(json!({ "id": pick.id, "reason": "not a date title" }));
            continue;
        };
        let done = sqlx::query(
            "UPDATE recordings SET filename = ?, title_source = 'date', updated_at = ? \
             WHERE id = ? AND user_id = ? AND deleted_at IS NULL AND filename = ?",
        )
        .bind(state.config.field_key.encrypt(&day))
        .bind(now_ms())
        .bind(&pick.id)
        .bind(&user.id)
        .bind(&encrypted)
        .execute(&state.db)
        .await?;
        if done.rows_affected() == 1 {
            renamed.push(json!({ "id": pick.id, "filename": day }));
        } else {
            skipped.push(json!({ "id": pick.id, "reason": "renamed" }));
        }
    }
    Ok(Json(json!({ "renamed": renamed, "skipped": skipped })))
}

// ---- upload, audio, peaks ----

/// Title of an upload in `original` mode: the file name without its extension, or the id when that is blank.
fn upload_title(stem: &str, id: &str) -> String {
    if stem.trim().is_empty() {
        id.to_owned()
    } else {
        stem.to_owned()
    }
}

/// The server's current UTC offset, read from the system `date` command. The time crate cannot
/// read it in a multi-threaded process on Unix. UTC when it cannot be read.
pub(crate) async fn local_offset() -> ::time::UtcOffset {
    let out = Command::new("date")
        .arg("+%z")
        .output()
        .await
        .ok()
        .filter(|o| o.status.success());
    out.and_then(|o| parse_offset(String::from_utf8_lossy(&o.stdout).trim()))
        .unwrap_or(::time::UtcOffset::UTC)
}

/// The UTC offset in effect at `ms`, so a date computed for a past instant follows the daylight
/// saving rules of that instant. Falls back to the current offset when the system cannot answer.
pub(crate) async fn local_offset_at(ms: i64) -> ::time::UtcOffset {
    let secs = ms.div_euclid(1000).to_string();
    // BSD date takes `-r <epoch>`, GNU date takes `-d @<epoch>`.
    for args in [["-r", secs.as_str(), "+%z"], ["-d", secs.as_str(), "+%z"]] {
        let arg = if args[0] == "-d" {
            format!("@{}", args[1])
        } else {
            args[1].to_owned()
        };
        let out = Command::new("date")
            .args([args[0], arg.as_str(), args[2]])
            .output()
            .await
            .ok()
            .filter(|o| o.status.success());
        if let Some(offset) =
            out.and_then(|o| parse_offset(String::from_utf8_lossy(&o.stdout).trim()))
        {
            return offset;
        }
    }
    local_offset().await
}

/// `+0800` / `-0530` → offset.
fn parse_offset(s: &str) -> Option<::time::UtcOffset> {
    let (sign, rest) = match s.as_bytes().first()? {
        b'+' => (1, &s[1..]),
        b'-' => (-1, &s[1..]),
        _ => return None,
    };
    if rest.len() != 4 {
        return None;
    }
    let hours: i8 = rest[..2].parse().ok()?;
    let minutes: i8 = rest[2..].parse().ok()?;
    ::time::UtcOffset::from_hms(sign * hours, sign * minutes, 0).ok()
}

/// Unix milliseconds at the given offset.
fn local_time(ms: i64, offset: ::time::UtcOffset) -> ::time::OffsetDateTime {
    ::time::OffsetDateTime::from_unix_timestamp_nanos(ms as i128 * 1_000_000)
        .unwrap_or(::time::OffsetDateTime::UNIX_EPOCH)
        .to_offset(offset)
}

/// Today as `YYYY-MM-DD` in server local time.
pub(crate) async fn local_date() -> String {
    let t = local_time(now_ms(), local_offset().await);
    format!("{:04}-{:02}-{:02}", t.year(), t.month() as u8, t.day())
}

/// A zip timestamp at the given offset. Falls back to the zip epoch (1980-01-01) when out of range.
fn zip_time(ms: i64, offset: ::time::UtcOffset) -> zip::DateTime {
    let t = local_time(ms, offset);
    u16::try_from(t.year())
        .ok()
        .and_then(|y| {
            zip::DateTime::from_date_and_time(
                y,
                t.month() as u8,
                t.day(),
                t.hour(),
                t.minute(),
                t.second(),
            )
            .ok()
        })
        .unwrap_or_default()
}

async fn upload(
    State(state): State<AppState>,
    user: CurrentUser,
    mut multipart: Multipart,
) -> ApiResult<Json<Value>> {
    let mut field = loop {
        let Some(field) = multipart.next_field().await.map_err(multipart_error)? else {
            return Err(
                AppError::bad_request("MISSING_REQUIRED_FIELD", "No file provided")
                    .detail("field", "file"),
            );
        };
        if field.name() == Some("file") && field.file_name().is_some() {
            break field;
        }
    };
    let file_name = field.file_name().unwrap_or_default().to_owned();
    let base = file_name.rsplit(['/', '\\']).next().unwrap_or_default();
    let path = Path::new(base);
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_owned();
    let accepted = ACCEPTED.contains(&ext.as_str());

    let id = ids::new_id();
    let dir = state.config.storage_root.join(&user.id);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(AppError::internal)?;
    let temp = dir.join(format!(".upload-{id}.partial"));
    let mut scratch = Scratch(vec![temp.clone()]);
    let mut out = tokio::fs::File::create(&temp)
        .await
        .map_err(AppError::internal)?;
    let mut md5 = <md5::Md5 as md5::Digest>::new();
    let mut size: u64 = 0;
    // The size limit is checked before the extension, as the spec orders the checks.
    while let Some(chunk) = field.chunk().await.map_err(multipart_error)? {
        size += chunk.len() as u64;
        if size > MAX_UPLOAD_BYTES {
            return Err(AppError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "FILE_TOO_LARGE",
                "File exceeds the 500 MB size limit",
            ));
        }
        if accepted {
            md5::Digest::update(&mut md5, &chunk);
            out.write_all(&chunk).await.map_err(AppError::internal)?;
        }
    }
    if !accepted {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "INVALID_FILE_FORMAT",
            "Unsupported format. Accepted: .mp3, .mp4, .m4a, .wav, .ogg, .opus, .webm, .aac, .flac",
        ));
    }
    out.flush().await.map_err(AppError::internal)?;
    out.sync_all().await.map_err(AppError::internal)?;
    drop(out);

    let probe = media::probe(&state.config.ffprobe, &temp)
        .await
        .ok_or_else(|| {
            AppError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "INVALID_FILE_FORMAT",
                "File does not contain a valid audio stream",
            )
        })?;
    let settings = crate::routes::settings::effective(&state, &user.id).await?;
    let by_date = settings.get("recordingTitleMode").and_then(Value::as_str) == Some("date");
    let title = if by_date {
        local_date().await
    } else {
        upload_title(&stem, &id)
    };
    let title_source = if by_date { "date" } else { "original" };
    let eligible = crate::export::auto::auto_export_eligible(&state, &user.id).await;
    let plaud_file_id = format!("uploaded-{id}");
    let stored = format!("{}/{plaud_file_id}.{ext}", user.id);
    let storage_type = state.storage.active_type();
    state
        .storage
        .store_staged(&stored, &temp, Some(mime_for(&ext)))
        .await?;

    let file_md5 = hex::encode(md5::Digest::finalize(md5));
    let saved = insert(
        &state.db,
        &state.config.field_key,
        NewRecording {
            id: &id,
            user_id: &user.id,
            plaud_file_id: &plaud_file_id,
            title: &title,
            duration: probe.duration_ms,
            start: now_ms(),
            filesize: size as i64,
            file_md5: &file_md5,
            storage_type,
            storage_path: &stored,
            title_source,
            auto_export_eligible: eligible,
        },
    )
    .await;
    if let Err(e) = saved {
        let _ = state.storage.delete(storage_type, &stored).await;
        return Err(e);
    }
    scratch.0.clear();
    if let Err(e) = crate::transcribe::queue_auto(&state, &user.id, &id).await {
        tracing::warn!(recording = id, error = %e.message, "queueing automatic transcription failed");
    }
    Ok(Json(json!({ "success": true, "filename": title })))
}

pub(crate) async fn audio(
    State(state): State<AppState>,
    user: CurrentUser,
    UrlPath(id): UrlPath<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let row = find(&state, &user.id, &id).await?;
    let ext = ext_of(&row.storage_path);
    let kind = row.storage_type.as_str();
    let key = row.storage_path.as_str();

    let download = query
        .get("download")
        .is_some_and(|v| matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes"));
    if download {
        let disposition = attachment(&format!(
            "{}.mp3",
            file_title(&title_of(&state, &row)?, &row.id)
        ));
        let head = vec![
            (header::CONTENT_TYPE, "audio/mpeg".to_owned()),
            (header::CONTENT_DISPOSITION, disposition),
            (header::CACHE_CONTROL, PRIVATE.to_owned()),
        ];
        if ext == "mp3" {
            let reader = state.storage.open_range(kind, key, 0, None).await?;
            return Ok(respond(StatusCode::OK, head, stream_with(reader, ())));
        }
        // ffmpeg reads a local file, so object storage is fetched to a temporary file first.
        let source = state.storage.materialize(kind, key).await?;
        let mut child =
            media::mp3_stream(&state.config.ffmpeg, source.path()).map_err(AppError::internal)?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AppError::internal("ffmpeg has no stdout"))?;
        return Ok(respond(
            StatusCode::OK,
            head,
            stream_with(stdout, (child, source)),
        ));
    }

    let size = state.storage.head_size(kind, key).await?;
    let mime = mime_for(&ext);
    let range = headers.get(header::RANGE).and_then(|v| v.to_str().ok());
    match parse_range(range, size) {
        Span::Unsatisfiable => Ok((
            StatusCode::RANGE_NOT_SATISFIABLE,
            [(header::CONTENT_RANGE, format!("bytes */{size}"))],
        )
            .into_response()),
        Span::Whole => {
            let reader = state.storage.open_range(kind, key, 0, None).await?;
            Ok(respond(
                StatusCode::OK,
                audio_headers(mime, size),
                stream_with(reader, ()),
            ))
        }
        Span::Part(start, end) => {
            let reader = state
                .storage
                .open_range(kind, key, start, Some(end))
                .await?;
            let len = end - start + 1;
            let mut head = audio_headers(mime, len);
            head.push((header::CONTENT_RANGE, format!("bytes {start}-{end}/{size}")));
            Ok(respond(
                StatusCode::PARTIAL_CONTENT,
                head,
                stream_with(reader, ()),
            ))
        }
    }
}

fn round3(x: f64) -> f64 {
    (x * 1000.0).round() / 1000.0
}

async fn peaks(
    State(state): State<AppState>,
    user: CurrentUser,
    UrlPath(id): UrlPath<String>,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    const SHAPE: &str = "Expected { peaks: number[] }";
    let parsed: Value = serde_json::from_slice(&body).map_err(|_| invalid(SHAPE))?;
    let values = parsed
        .get("peaks")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid(SHAPE))?;
    if !(32..=2048).contains(&values.len()) {
        return Err(invalid("peaks must contain between 32 and 2048 values"));
    }
    let mut out = Vec::with_capacity(values.len());
    for v in values {
        match v.as_f64() {
            Some(x) if (0.0..=1.0).contains(&x) => out.push(round3(x)),
            _ => return Err(invalid("peaks must be finite numbers in [0, 1]")),
        }
    }
    find(&state, &user.id, &id).await?;
    let stored = sqlx::query(
        "UPDATE recordings SET waveform_peaks = ?, updated_at = ? \
         WHERE id = ? AND user_id = ? AND deleted_at IS NULL AND waveform_peaks IS NULL",
    )
    .bind(serde_json::to_string(&out).map_err(AppError::internal)?)
    .bind(now_ms())
    .bind(id.as_str())
    .bind(user.id.as_str())
    .execute(&state.db)
    .await?;
    Ok(Json(json!({ "stored": stored.rows_affected() == 1 })))
}

// ---- batch download and merge ----

/// Runs `f` on the archive on a blocking thread and hands the writer back. The zip is moved in
/// and out, as in the backup writer, so the file has one owner at a time.
async fn with_zip<F>(
    zip: zip::ZipWriter<std::fs::File>,
    f: F,
) -> std::io::Result<zip::ZipWriter<std::fs::File>>
where
    F: FnOnce(&mut zip::ZipWriter<std::fs::File>) -> std::io::Result<()> + Send + 'static,
{
    tokio::task::spawn_blocking(move || {
        let mut zip = zip;
        f(&mut zip)?;
        Ok(zip)
    })
    .await
    .map_err(std::io::Error::other)?
}

/// Appends one stored entry whose bytes are copied from `src`.
async fn append_audio(
    zip: zip::ZipWriter<std::fs::File>,
    name: String,
    src: PathBuf,
    start_ms: i64,
    offset: ::time::UtcOffset,
) -> std::io::Result<zip::ZipWriter<std::fs::File>> {
    with_zip(zip, move |zip| {
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored)
            .last_modified_time(zip_time(start_ms, offset));
        zip.start_file(name.as_str(), opts)
            .map_err(std::io::Error::other)?;
        std::io::copy(&mut std::fs::File::open(&src)?, zip)?;
        Ok(())
    })
    .await
}

/// Closes the archive and syncs it to disk.
fn close_zip(zip: zip::ZipWriter<std::fs::File>) -> std::io::Result<()> {
    let file = zip.finish().map_err(std::io::Error::other)?;
    file.sync_all()
}

async fn download(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(query): Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    let format = query.get("format").map_or("mp3", |s| s.as_str());
    if format != "mp3" && format != "original" {
        return Err(invalid("format must be mp3 or original"));
    }
    let mut wanted: Vec<String> = Vec::new();
    for part in query.get("ids").map_or("", |s| s.as_str()).split(',') {
        if !valid_id(part) {
            return Err(invalid("ids must be 1 to 100 recording ids"));
        }
        if !wanted.iter().any(|id| id.as_str() == part) {
            wanted.push(part.to_owned());
        }
    }
    if wanted.len() > 100 {
        return Err(invalid("ids must be 1 to 100 recording ids"));
    }
    let original = format == "original";
    let rows = ordered(fetch_many(&state.db, &user.id, &wanted).await?, &wanted);
    if rows.is_empty() {
        return Err(not_found());
    }

    if original && wanted.len() == 1 {
        let row = &rows[0];
        let ext = ext_of(&row.storage_path);
        let size = state
            .storage
            .head_size(&row.storage_type, &row.storage_path)
            .await?;
        let file = state
            .storage
            .open_range(&row.storage_type, &row.storage_path, 0, None)
            .await?;
        let name = format!("{}.{ext}", file_title(&title_of(&state, row)?, &row.id));
        let head = vec![
            (header::CONTENT_TYPE, mime_for(&ext).to_owned()),
            (header::CONTENT_LENGTH, size.to_string()),
            (header::CONTENT_DISPOSITION, attachment(&name)),
            (header::CACHE_CONTROL, PRIVATE.to_owned()),
        ];
        return Ok(respond(StatusCode::OK, head, stream_with(file, ())));
    }

    let dir = state.config.storage_root.join(&user.id);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(AppError::internal)?;
    let mut scratch = Scratch::default();
    let zip_path = dir.join(format!(".zip-{}.partial", ids::new_id()));
    scratch.0.push(zip_path.clone());
    let file = tokio::fs::File::create(&zip_path)
        .await
        .map_err(AppError::internal)?
        .into_std()
        .await;
    let mut zip = zip::ZipWriter::new(file);
    let offset = local_offset().await;
    let mut taken = HashSet::new();
    let mut errors: Vec<String> = Vec::new();
    // Object-storage audio is fetched only while its entry is written, so the temporary copy
    // is dropped as soon as it is in the archive.
    for row in &rows {
        let ext = if original {
            ext_of(&row.storage_path)
        } else {
            "mp3".to_owned()
        };
        let base = file_title(&title_of(&state, row)?, &row.id);
        let name = unique_name(&mut taken, &base, &ext);
        let src = match state
            .storage
            .materialize(&row.storage_type, &row.storage_path)
            .await
        {
            Ok(src) => src,
            Err(StorageError::NotFound) => {
                errors.push(format!("{name}: audio file is missing"));
                continue;
            }
            Err(e) => return Err(e.into()),
        };
        if original || ext_of(&row.storage_path) == "mp3" {
            zip = append_audio(zip, name, src.path().to_path_buf(), row.start_time, offset)
                .await
                .map_err(AppError::internal)?;
        } else {
            let tmp = dir.join(format!(".part-{}.mp3", ids::new_id()));
            scratch.0.push(tmp.clone());
            if media::to_mp3(&state.config.ffmpeg, src.path(), &tmp).await {
                zip = append_audio(zip, name, tmp.clone(), row.start_time, offset)
                    .await
                    .map_err(AppError::internal)?;
                let _ = tokio::fs::remove_file(&tmp).await;
            } else {
                errors.push(format!("{name}: could not be converted"));
            }
        }
    }

    if !errors.is_empty() {
        let listing = format!("{}\n", errors.join("\n"));
        zip = with_zip(zip, move |zip| {
            use std::io::Write;
            let base = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            zip.start_file("errors.txt", base)
                .map_err(std::io::Error::other)?;
            zip.write_all(listing.as_bytes())
        })
        .await
        .map_err(AppError::internal)?;
    }
    tokio::task::spawn_blocking(move || close_zip(zip))
        .await
        .map_err(AppError::internal)?
        .map_err(AppError::internal)?;

    let file = tokio::fs::File::open(&zip_path)
        .await
        .map_err(AppError::internal)?;
    let size = file.metadata().await.map_err(AppError::internal)?.len();
    let name = format!("OpenAudioHub-{}.zip", local_date().await);
    let head = vec![
        (header::CONTENT_TYPE, "application/zip".to_owned()),
        (header::CONTENT_LENGTH, size.to_string()),
        (header::CONTENT_DISPOSITION, attachment(&name)),
        (header::CACHE_CONTROL, PRIVATE.to_owned()),
    ];
    Ok(respond(StatusCode::OK, head, stream_with(file, scratch)))
}

fn valid_distinct(ids: &[String]) -> bool {
    ids.iter().all(|id| valid_id(id)) && ids.iter().collect::<HashSet<_>>().len() == ids.len()
}

/// The latest transcript of one merge input, with the length of its audio.
struct Part {
    text: String,
    language: Option<String>,
    provider: String,
    model: String,
    transcription_type: String,
    /// Timeline items and their source, when the input has them.
    timeline: Option<(Vec<Value>, String)>,
    duration_ms: i64,
}

/// The transcript of the merged recording.
struct Joined {
    text: String,
    language: Option<String>,
    provider: String,
    model: String,
    transcription_type: String,
    timeline: Option<(Value, String)>,
}

/// Texts are joined in input order with a blank line. The language is kept only when every input has it.
/// The timeline is kept only when every input has one from the same source; each item moves by the
/// audio length before its input.
fn join_parts(parts: &[Part]) -> Joined {
    let text = parts
        .iter()
        .map(|p| p.text.trim())
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    let language = parts[0]
        .language
        .clone()
        .filter(|l| parts.iter().all(|p| p.language.as_ref() == Some(l)));
    let first = &parts[0];
    Joined {
        text,
        language,
        provider: first.provider.clone(),
        model: first.model.clone(),
        transcription_type: first.transcription_type.clone(),
        timeline: merged_timeline(parts),
    }
}

fn merged_timeline(parts: &[Part]) -> Option<(Value, String)> {
    let source = parts[0].timeline.as_ref()?.1.clone();
    let mut items = Vec::new();
    let mut offset = 0;
    for part in parts {
        let (list, part_source) = part.timeline.as_ref()?;
        if *part_source != source {
            return None;
        }
        for item in list {
            let mut item = item.clone();
            for key in ["start_ms", "end_ms"] {
                let ms = item.get(key)?.as_i64()?;
                item[key] = json!(ms + offset);
            }
            items.push(item);
        }
        offset += part.duration_ms;
    }
    Some((Value::Array(items), source))
}

/// The latest transcript of each input, in input order. `None` unless every input has one.
async fn input_parts(
    state: &AppState,
    user_id: &str,
    rows: &[Row],
    probes: &[media::Probe],
) -> ApiResult<Option<Vec<Part>>> {
    let mut parts = Vec::with_capacity(rows.len());
    for (row, probe) in rows.iter().zip(probes) {
        let latest: Option<TranscriptRow> = sqlx::query_as(
            "SELECT id, recording_id, user_id, text, detected_language, transcription_type, provider, model, timeline, \
             timeline_source, source, created_at FROM transcriptions WHERE recording_id = ? AND user_id = ? \
             ORDER BY created_at DESC LIMIT 1",
        )
        .bind(row.id.as_str())
        .bind(user_id)
        .fetch_optional(&state.db)
        .await?;
        let Some(t) = latest else {
            return Ok(None);
        };
        let timeline = t
            .timeline
            .as_deref()
            .and_then(|raw| {
                let v = serde_json::from_str::<Value>(raw).ok()?;
                let dec = state.config.field_key.decrypt_json(&v).ok()?;
                serde_json::from_value::<Vec<Value>>(dec).ok()
            })
            .zip(t.timeline_source.clone());
        parts.push(Part {
            text: state
                .config
                .field_key
                .decrypt(&t.text)
                .map_err(AppError::internal)?,
            language: t.detected_language,
            provider: t.provider,
            model: t.model,
            transcription_type: t.transcription_type,
            timeline,
            duration_ms: probe.duration_ms,
        });
    }
    Ok(Some(parts))
}

/// Saves the merged transcript as this recording's own. This does not run the after-transcript steps,
/// so no AI title or summary is generated for the merge.
async fn store_joined(
    state: &AppState,
    user_id: &str,
    recording_id: &str,
    joined: &Joined,
) -> ApiResult<()> {
    let (timeline, source) = match &joined.timeline {
        Some((value, source)) => (
            Some(state.config.field_key.encrypt_json(value).to_string()),
            Some(source.as_str()),
        ),
        None => (None, None),
    };
    sqlx::query(
        "INSERT INTO transcriptions (id, recording_id, user_id, text, detected_language, transcription_type, provider, model, \
         timeline, timeline_source, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'openaudiohub', ?)",
    )
    .bind(ids::new_id())
    .bind(recording_id)
    .bind(user_id)
    .bind(state.config.field_key.encrypt(&joined.text))
    .bind(&joined.language)
    .bind(&joined.transcription_type)
    .bind(&joined.provider)
    .bind(&joined.model)
    .bind(timeline)
    .bind(source)
    .bind(now_ms())
    .execute(&state.db)
    .await?;
    Ok(())
}

async fn merge(
    State(state): State<AppState>,
    user: CurrentUser,
    body: Bytes,
) -> ApiResult<Response> {
    let value: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let wanted: Option<Vec<String>> = value
        .get("ids")
        .and_then(Value::as_array)
        .and_then(|a| a.iter().map(|v| v.as_str().map(str::to_owned)).collect());
    let wanted = match wanted {
        Some(ids) if (2..=100).contains(&ids.len()) && valid_distinct(&ids) => ids,
        _ => return Err(invalid("ids must be 2 to 100 distinct recording ids")),
    };
    let title = match value.get("title") {
        None | Some(Value::Null) => None,
        Some(Value::String(t)) if t.trim().chars().count() <= 255 => {
            Some(t.trim().to_owned()).filter(|t| !t.is_empty())
        }
        Some(_) => return Err(invalid("title must be at most 255 characters")),
    };

    let rows = ordered(fetch_many(&state.db, &user.id, &wanted).await?, &wanted);
    if rows.len() != wanted.len() {
        return Err(not_found());
    }
    let key = &state.config.field_key;
    // Inputs stored in object storage are fetched to temporary files that live until the merge ends.
    let mut inputs: Vec<LocalFile> = Vec::with_capacity(rows.len());
    let mut probes = Vec::with_capacity(rows.len());
    for row in &rows {
        let source = state
            .storage
            .materialize(&row.storage_type, &row.storage_path)
            .await;
        let probe = match &source {
            Ok(file) => media::probe(&state.config.ffprobe, file.path()).await,
            Err(_) => None,
        };
        match (source, probe) {
            (Ok(file), Some(probe)) => {
                inputs.push(file);
                probes.push(probe);
            }
            _ => {
                let name = title_of(&state, row)?;
                return Err(AppError::new(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "INVALID_FILE_FORMAT",
                    format!("\"{name}\" has no readable audio"),
                ));
            }
        }
    }
    let total: i64 = probes.iter().map(|p| p.duration_ms).sum();
    if total > MAX_MERGE_MS {
        return Err(AppError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "INVALID_INPUT",
            "Merged recording would be longer than 24 hours",
        ));
    }
    let parts = input_parts(&state, &user.id, &rows, &probes).await?;

    let dir = state.config.storage_root.join(&user.id);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(AppError::internal)?;
    let id = ids::new_id();
    let temp = dir.join(format!(".merge-{id}.partial"));
    let list = dir.join(format!(".merge-{id}.list"));
    let _scratch = Scratch(vec![temp.clone(), list.clone()]);
    let paths: Vec<PathBuf> = inputs.iter().map(|f| f.path().to_path_buf()).collect();
    // Stream copy only when every input is the same Ogg-friendly codec; otherwise re-encode.
    let same = probes
        .iter()
        .all(|p| p.codec == probes[0].codec && p.format == probes[0].format)
        && matches!(probes[0].codec.as_str(), "opus" | "vorbis");
    let mut cmd = Command::new(&state.config.ffmpeg);
    cmd.args(["-v", "error"]);
    if same {
        let text: String = paths
            .iter()
            .map(|p| {
                format!(
                    "file '{}'\n",
                    p.display().to_string().replace('\'', r"'\''")
                )
            })
            .collect();
        tokio::fs::write(&list, text)
            .await
            .map_err(AppError::internal)?;
        cmd.args(["-f", "concat", "-safe", "0", "-i"])
            .arg(&list)
            .args(["-vn", "-c", "copy"]);
    } else {
        let mut filter = String::new();
        for (i, path) in paths.iter().enumerate() {
            cmd.arg("-i").arg(path);
            filter.push_str(&format!("[{i}:a:0]"));
        }
        filter.push_str(&format!("concat=n={}:v=0:a=1[out]", paths.len()));
        cmd.args([
            "-filter_complex",
            filter.as_str(),
            "-map",
            "[out]",
            "-c:a",
            "libopus",
        ]);
    }
    cmd.args(["-f", "ogg"]).arg(&temp);
    if !media::run(&mut cmd).await {
        return Err(AppError::internal("merge: ffmpeg failed"));
    }

    let out_probe = media::probe(&state.config.ffprobe, &temp)
        .await
        .ok_or_else(|| AppError::internal("merge: output is unreadable"))?;
    let file_md5 = media::file_md5(&temp).await.map_err(AppError::internal)?;
    let size = tokio::fs::metadata(&temp)
        .await
        .map_err(AppError::internal)?
        .len();
    let name = match title {
        Some(t) => t,
        None => format!("{} (merged)", title_of(&state, &rows[0])?),
    };
    let stored = format!("{}/merged-{id}.ogg", user.id);
    let storage_type = state.storage.active_type();
    state
        .storage
        .store_staged(&stored, &temp, Some("audio/ogg"))
        .await?;

    let start = rows
        .iter()
        .map(|r| r.start_time)
        .min()
        .unwrap_or_else(now_ms);
    let plaud_file_id = format!("merged-{id}");
    // A merged recording is made here, so its title is the user's and sync never rewrites it.
    let title_source = "manual";
    let eligible = crate::export::auto::auto_export_eligible(&state, &user.id).await;
    let saved = insert(
        &state.db,
        key,
        NewRecording {
            id: &id,
            user_id: &user.id,
            plaud_file_id: &plaud_file_id,
            title: &name,
            duration: out_probe.duration_ms,
            start,
            filesize: size as i64,
            file_md5: &file_md5,
            storage_type,
            storage_path: &stored,
            title_source,
            auto_export_eligible: eligible,
        },
    )
    .await;
    if let Err(e) = saved {
        let _ = state.storage.delete(storage_type, &stored).await;
        return Err(e);
    }
    if let Some(parts) = parts {
        // The merge already succeeded; a failed transcript copy is logged, not returned.
        if let Err(e) = store_joined(&state, &user.id, &id, &join_parts(&parts)).await {
            tracing::warn!(recording = id, error = %e.message, "saving the merged transcript failed");
        }
    }
    Ok((StatusCode::CREATED, Json(json!({ "id": id }))).into_response())
}

/// Starts the background waveform backfill for recordings missing peaks.
pub fn spawn_waveform_backfill(state: &AppState) {
    let state = state.clone();
    tokio::spawn(async move {
        let rows: Vec<(String, String, String)> = match sqlx::query_as(
            "SELECT id, storage_path, storage_type FROM recordings WHERE waveform_peaks IS NULL AND storage_path != '' AND deleted_at IS NULL",
        )
        .fetch_all(&state.db)
        .await
        {
            Ok(r) => r,
            Err(_) => return,
        };

        for (id, storage_path, storage_type) in rows {
            if let Ok(source) = state
                .storage
                .materialize(&storage_type, &storage_path)
                .await
                && let Some(peaks) =
                    media::compute_peaks(&state.config.ffmpeg, source.path(), 256).await
                && let Ok(json_str) = serde_json::to_string(&peaks)
            {
                let _ = sqlx::query(
                            "UPDATE recordings SET waveform_peaks = ? WHERE id = ? AND waveform_peaks IS NULL",
                        )
                        .bind(json_str)
                        .bind(&id)
                        .execute(&state.db)
                        .await;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offsets_from_date() {
        assert_eq!(
            parse_offset("+0800"),
            ::time::UtcOffset::from_hms(8, 0, 0).ok()
        );
        assert_eq!(
            parse_offset("-0530"),
            ::time::UtcOffset::from_hms(-5, -30, 0).ok()
        );
        assert_eq!(parse_offset("0800"), None);
        assert_eq!(parse_offset("+08"), None);
        let t = zip_time(0, ::time::UtcOffset::from_hms(8, 0, 0).unwrap());
        assert_eq!(
            (t.year(), t.hour()),
            (1980, 0),
            "1970 is before the zip epoch"
        );
        let t = zip_time(
            1_760_000_000_000,
            ::time::UtcOffset::from_hms(8, 0, 0).unwrap(),
        );
        assert_eq!((t.year(), t.month(), t.day(), t.hour()), (2025, 10, 9, 16));
    }

    #[test]
    fn range_forms() {
        assert_eq!(parse_range(None, 100), Span::Whole);
        assert_eq!(parse_range(Some("bytes=0-99"), 100), Span::Part(0, 99));
        assert_eq!(parse_range(Some("bytes=10-"), 100), Span::Part(10, 99));
        assert_eq!(parse_range(Some("bytes=-20"), 100), Span::Whole);
        assert_eq!(parse_range(Some("bytes=0-1,5-6"), 100), Span::Whole);
        assert_eq!(parse_range(Some("items=0-1"), 100), Span::Whole);
        assert_eq!(parse_range(Some("bytes=abc-5"), 100), Span::Whole);
        assert_eq!(parse_range(Some("bytes=100-"), 100), Span::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=10-5"), 100), Span::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=0-100"), 100), Span::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=0-0"), 0), Span::Unsatisfiable);
    }

    #[test]
    fn names_and_titles() {
        assert_eq!(file_title("a/b:c  d\te", "fallback"), "a-b-c d e");
        assert_eq!(file_title("   ", "fallback"), "fallback");
        assert_eq!(
            attachment("a b.mp3"),
            "attachment; filename=\"a b.mp3\"; filename*=UTF-8''a%20b.mp3"
        );
        let mut taken = HashSet::new();
        assert_eq!(unique_name(&mut taken, "Twin", "mp3"), "Twin.mp3");
        assert_eq!(unique_name(&mut taken, "twin", "mp3"), "twin (2).mp3");
    }

    fn part(
        text: &str,
        language: Option<&str>,
        timeline: Option<(Vec<Value>, &str)>,
        duration_ms: i64,
    ) -> Part {
        Part {
            text: text.to_owned(),
            language: language.map(str::to_owned),
            provider: "p".to_owned(),
            model: "m".to_owned(),
            transcription_type: "server".to_owned(),
            timeline: timeline.map(|(items, source)| (items, source.to_owned())),
            duration_ms,
        }
    }

    #[test]
    fn transcript_json_decrypts_encrypted_timeline() {
        let key =
            FieldKey::from_hex("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff")
                .unwrap();
        let raw_timeline = json!([
            {"start_ms": 100, "end_ms": 500, "text": "hello", "speaker_id": "Speaker 1"}
        ]);
        let encrypted_timeline = key.encrypt_json(&raw_timeline).to_string();
        let encrypted_text = key.encrypt("hello");
        let row = TranscriptRow {
            id: "t1".into(),
            recording_id: "r1".into(),
            user_id: "u1".into(),
            text: encrypted_text,
            detected_language: Some("en".into()),
            transcription_type: "server".into(),
            provider: "plaud".into(),
            model: "native".into(),
            timeline: Some(encrypted_timeline),
            timeline_source: Some("native".into()),
            source: "plaud".into(),
            created_at: 1_700_000_000,
        };
        let res = transcript_json(&key, row).expect("transcript_json");
        assert_eq!(res["text"], "hello");
        assert_eq!(res["timeline"], raw_timeline);
    }

    #[tokio::test]
    async fn upload_title_modes() {
        assert_eq!(upload_title("tone-3s", "abc"), "tone-3s");
        assert_eq!(upload_title("  ", "abc"), "abc");
        let date = local_date().await;
        assert_eq!(date.len(), 10);
        assert!(date.chars().enumerate().all(|(i, c)| if i == 4 || i == 7 {
            c == '-'
        } else {
            c.is_ascii_digit()
        }));
    }

    #[test]
    fn merged_transcript_joins_texts_and_offsets_timeline() {
        let a = part(
            " Hello there. \n",
            Some("en"),
            Some((
                vec![json!({"start_ms": 0, "end_ms": 900, "text": "a"})],
                "native",
            )),
            1_000,
        );
        let b = part(
            "",
            Some("en"),
            Some((
                vec![json!({"start_ms": 100, "end_ms": 400, "text": "b"})],
                "native",
            )),
            2_000,
        );
        let c = part("Bye", Some("en"), Some((vec![], "native")), 500);
        let joined = join_parts(&[a, b, c]);
        assert_eq!(joined.text, "Hello there.\n\nBye");
        assert_eq!(joined.language.as_deref(), Some("en"));
        let (timeline, source) = joined.timeline.expect("timeline kept");
        assert_eq!(source, "native");
        assert_eq!(timeline[0]["start_ms"], 0);
        assert_eq!(timeline[0]["end_ms"], 900);
        assert_eq!(timeline[1]["start_ms"], 1_100);
        assert_eq!(timeline[1]["end_ms"], 1_400);
    }

    #[test]
    fn merged_transcript_drops_mixed_language_and_timeline() {
        let a = part(
            "One",
            Some("en"),
            Some((vec![json!({"start_ms": 0, "end_ms": 1})], "native")),
            1_000,
        );
        let b = part("Two", Some("fr"), None, 1_000);
        let joined = join_parts(&[a, b]);
        assert_eq!(joined.language, None);
        assert!(joined.timeline.is_none());
        let c = part(
            "Two",
            Some("en"),
            Some((vec![json!({"start_ms": 0, "end_ms": 1})], "normalized")),
            1_000,
        );
        let d = part(
            "One",
            Some("en"),
            Some((vec![json!({"start_ms": 0, "end_ms": 1})], "native")),
            1_000,
        );
        assert!(join_parts(&[d, c]).timeline.is_none());
    }

    #[tokio::test]
    async fn list_is_newest_first_and_serialized() {
        let db = crate::db::open_memory().await.unwrap();
        let key = FieldKey::from_hex(&ids::token_hex(32)).unwrap();
        sqlx::query("INSERT INTO users (id, email, created_at, updated_at) VALUES ('u1', 'u1@example.test', 0, 0)")
            .execute(&db)
            .await
            .unwrap();
        for (id, start, name) in [("older", 1_000_i64, "Older"), ("newer", 5_000, "Newer")] {
            let md5 = "0".repeat(32);
            let storage = format!("u1/{id}.mp3");
            let new = NewRecording {
                id,
                user_id: "u1",
                plaud_file_id: id,
                title: name,
                duration: 3_000,
                start,
                filesize: 10,
                file_md5: &md5,
                storage_type: "local",
                storage_path: &storage,
                title_source: "original",
                auto_export_eligible: false,
            };
            insert(&db, &key, new).await.unwrap();
        }
        let rows = list_rows(&db, &key, "u1").await.unwrap();
        let names: Vec<&str> = rows
            .iter()
            .map(|r| r["filename"].as_str().unwrap())
            .collect();
        assert_eq!(names, ["Newer", "Older"]);
        assert_eq!(rows[0]["startTime"], time::iso(5_000));
        assert_eq!(rows[0]["endTime"], time::iso(8_000));
        assert_eq!(rows[0]["storageType"], "local");
        assert_eq!(rows[0]["isTrash"], false);
        assert_eq!(rows[0]["waveformPeaks"], Value::Null);
        assert_eq!(rows[0]["deletedAt"], Value::Null);
    }

    async fn read_body(res: Response) -> Vec<u8> {
        axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec()
    }

    #[tokio::test]
    async fn mixed_library_streams_ranges_zips_and_deletes() {
        use crate::config::{Config, StorageType};
        use std::io::Read;

        let dir = tempfile::tempdir().unwrap();
        let (endpoint, objects, server) = crate::storage::fake_s3::start().await;
        let mut config = Config::for_tests(dir.path());
        config.storage_type = StorageType::S3;
        config.s3 = crate::storage::fake_s3::s3_settings(endpoint);
        let db = crate::db::open_memory().await.unwrap();
        sqlx::query("INSERT INTO users (id, email, created_at, updated_at) VALUES ('u1', 'u1@example.test', 0, 0)")
            .execute(&db)
            .await
            .unwrap();
        let state = AppState::new(config, db);
        let user = || CurrentUser {
            id: "u1".into(),
            email: "u1@example.test".into(),
            name: None,
            session_id: "s1".into(),
        };

        // A local row from before the switch: its file is already in the local folder.
        let (local_id, s3_id) = (ids::new_id(), ids::new_id());
        let local_key = format!("u1/{local_id}.mp3");
        std::fs::create_dir_all(state.config.storage_root.join("u1")).unwrap();
        std::fs::write(state.config.storage_root.join(&local_key), b"local audio").unwrap();
        // An S3 row, written through the active backend.
        let s3_key = format!("u1/{s3_id}.mp3");
        let staged = dir.path().join("staged.mp3");
        std::fs::write(&staged, b"0123456789").unwrap();
        state
            .storage
            .store_staged(&s3_key, &staged, Some("audio/mpeg"))
            .await
            .unwrap();

        let md5 = "0".repeat(32);
        for (id, kind, key, start) in [
            (&local_id, "local", &local_key, 1_000_i64),
            (&s3_id, "s3", &s3_key, 2_000),
        ] {
            insert(
                &state.db,
                &state.config.field_key,
                NewRecording {
                    id,
                    user_id: "u1",
                    plaud_file_id: id,
                    title: id,
                    duration: 3_000,
                    start,
                    filesize: 10,
                    file_md5: &md5,
                    storage_type: kind,
                    storage_path: key,
                    title_source: "original",
                    auto_export_eligible: false,
                },
            )
            .await
            .unwrap();
        }

        // Range on the S3 row: 206 with the slice from the object.
        let mut headers = HeaderMap::new();
        headers.insert(header::RANGE, HeaderValue::from_static("bytes=2-5"));
        let res = audio(
            State(state.clone()),
            user(),
            UrlPath(s3_id.clone()),
            Query(HashMap::new()),
            headers,
        )
        .await
        .unwrap();
        assert_eq!(res.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            res.headers()[header::CONTENT_RANGE].to_str().unwrap(),
            "bytes 2-5/10"
        );
        assert_eq!(read_body(res).await, b"2345");

        // Full stream of the local row is unchanged.
        let res = audio(
            State(state.clone()),
            user(),
            UrlPath(local_id.clone()),
            Query(HashMap::new()),
            HeaderMap::new(),
        )
        .await
        .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(read_body(res).await, b"local audio");

        // Batch original download reads both backends into one archive.
        let query = HashMap::from([
            ("ids".to_owned(), format!("{local_id},{s3_id}")),
            ("format".to_owned(), "original".to_owned()),
        ]);
        let res = download(State(state.clone()), user(), Query(query))
            .await
            .unwrap();
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(read_body(res).await)).unwrap();
        let mut entries = HashMap::new();
        for i in 0..zip.len() {
            let mut file = zip.by_index(i).unwrap();
            let name = file.name().unwrap().into_owned();
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes).unwrap();
            entries.insert(name, bytes);
        }
        assert_eq!(
            entries.get(&format!("{local_id}.mp3")).map(Vec::as_slice),
            Some(&b"local audio"[..])
        );
        assert_eq!(
            entries.get(&format!("{s3_id}.mp3")).map(Vec::as_slice),
            Some(&b"0123456789"[..])
        );

        // Delete the S3 row: the object goes, then the row answers 404.
        let _ = remove(State(state.clone()), user(), UrlPath(s3_id.clone()))
            .await
            .unwrap();
        assert!(objects.lock().unwrap().is_empty());
        assert!(
            audio(
                State(state.clone()),
                user(),
                UrlPath(s3_id.clone()),
                Query(HashMap::new()),
                HeaderMap::new(),
            )
            .await
            .is_err()
        );

        // Delete the local row: its file goes too.
        let _ = remove(State(state.clone()), user(), UrlPath(local_id.clone()))
            .await
            .unwrap();
        assert!(!state.config.storage_root.join(&local_key).exists());
        server.abort();
    }
}
