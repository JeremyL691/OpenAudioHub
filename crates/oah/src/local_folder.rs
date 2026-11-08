//! Custom local storage folder sync (`/api/settings/storage/sync`) and background watcher.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::{Duration, SystemTime};

use axum::extract::State;
use axum::routing::post;
use axum::{Json, Router};
use serde_json::{Map, Value, json};
use tokio::sync::{Mutex, Notify};

use crate::AppState;
use crate::auth::CurrentUser;
use crate::db::now_ms;
use crate::error::{ApiResult, AppError};
use crate::ids;
use crate::routes::recordings::{self, media};
use crate::routes::settings::effective;
use crate::zip_merge;

const TICK: Duration = Duration::from_secs(10);
const ACCEPTED_AUDIO: [&str; 9] = [
    "mp3", "mp4", "m4a", "wav", "ogg", "opus", "webm", "aac", "flac",
];

static SCAN_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
static WAKE: LazyLock<Notify> = LazyLock::new(Notify::new);

#[derive(Default)]
pub struct SyncReport {
    pub synced: u32,
    pub removed: u32,
    pub errors: Vec<String>,
}

pub fn router() -> Router<AppState> {
    Router::new().route("/api/settings/storage/sync", post(sync_route))
}

/// Wakes the background loop so a folder change takes effect immediately.
pub fn notify() {
    WAKE.notify_one();
}

/// Acquires the folder sync mutex so external writers (`zip_merge`, `upload`, `merge`, `auto_export`)
/// can atomically place or rename files in `localStorageFolder` and commit their DB rows before
/// `sync_user` scans the directory.
pub async fn lock() -> tokio::sync::MutexGuard<'static, ()> {
    SCAN_LOCK.lock().await
}

/// Returns the canonical filesystem path string when `path` can be canonicalized, or the raw
/// path string otherwise.
pub fn normalize_path(path: &Path) -> String {
    std::fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

/// True when `a` and `b` refer to the same directory (either identical paths or identical canonical paths).
pub fn same_dir(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(ca), Ok(cb)) => ca == cb,
        _ => false,
    }
}

/// True when `file_path`'s parent directory is `folder` (comparing raw and canonical paths).
pub fn is_in_folder(file_path: &Path, folder: &Path) -> bool {
    let Some(parent) = file_path.parent() else {
        return false;
    };
    same_dir(parent, folder)
}

/// Starts the background folder sync loop.
pub fn spawn(state: &AppState) {
    if state.config.desktop.is_none() && state.config.multi_user {
        return;
    }
    let state = state.clone();
    tokio::spawn(async move {
        loop {
            if let Err(e) = auto_pass(&state).await {
                tracing::warn!(error = %e.message, "local folder background sync pass failed");
            }
            tokio::select! {
                _ = tokio::time::sleep(TICK) => {}
                _ = WAKE.notified() => {}
            }
        }
    });
}

async fn auto_pass(state: &AppState) -> ApiResult<()> {
    let users: Vec<String> = sqlx::query_scalar(
        "SELECT user_id FROM user_settings WHERE json_extract(data, '$.localStorageFolder') IS NOT NULL AND json_extract(data, '$.localStorageFolder') <> ''",
    )
    .fetch_all(&state.db)
    .await?;
    for user_id in users {
        let settings = effective(state, &user_id).await?;
        let Some(folder) = settings
            .get("localStorageFolder")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|f| !f.is_empty())
            .map(PathBuf::from)
        else {
            continue;
        };
        if let Err(e) = sync_user(state, &user_id, &folder, &settings, false).await {
            tracing::warn!(user = %user_id, error = %e.message, "local folder sync failed for user");
        }
    }
    Ok(())
}

async fn sync_route(State(state): State<AppState>, user: CurrentUser) -> ApiResult<Json<Value>> {
    let settings = effective(&state, &user.id).await?;
    let Some(folder) = settings
        .get("localStorageFolder")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
    else {
        return Ok(Json(json!({
            "success": true,
            "synced": 0,
            "removed": 0,
            "errors": [],
        })));
    };
    let report = sync_user(&state, &user.id, &folder, &settings, true).await?;
    Ok(Json(json!({
        "success": true,
        "synced": report.synced,
        "removed": report.removed,
        "errors": report.errors,
    })))
}

#[derive(Clone, sqlx::FromRow)]
struct ExistingRow {
    id: String,
    plaud_file_id: Option<String>,
    filename: String,
    storage_type: String,
    storage_path: String,
    file_md5: String,
    filesize: i64,
    title_source: String,
    waveform_peaks: Option<String>,
    auto_export_path: Option<String>,
    auto_export_target: Option<String>,
    deleted_at: Option<i64>,
}

struct Candidate {
    path: PathBuf,
    file_path_str: String,
    file_name: String,
    stem: String,
    filesize: i64,
    start_ms: i64,
}

fn insert_active_path(set: &mut HashSet<String>, raw: &str) {
    if raw.is_empty() {
        return;
    }
    set.insert(raw.to_owned());
    set.insert(normalize_path(Path::new(raw)));
}

/// Synchronizes `folder` with the user's Library recordings.
pub async fn sync_user(
    state: &AppState,
    user_id: &str,
    folder: &Path,
    settings: &Map<String, Value>,
    manual: bool,
) -> ApiResult<SyncReport> {
    let _guard = SCAN_LOCK.lock().await;
    let mut report = SyncReport::default();

    let mut read_dir = match tokio::fs::read_dir(folder).await {
        Ok(rd) => rd,
        Err(e) => {
            if manual {
                return Err(AppError::bad_request(
                    "INVALID_INPUT",
                    format!("Could not read local storage folder: {e}"),
                )
                .detail("field", "localStorageFolder"));
            }
            return Ok(report);
        }
    };

    let mut existing: Vec<ExistingRow> = sqlx::query_as(
        "SELECT id, plaud_file_id, filename, storage_type, storage_path, file_md5, filesize, title_source, \
                waveform_peaks, auto_export_path, auto_export_target, deleted_at \
         FROM recordings WHERE user_id = ?",
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await?;

    let zip_rows: Vec<(Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT recording_id, export_path FROM zip_imports WHERE user_id = ? AND export_path IS NOT NULL",
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await?;
    let mut zip_export_paths: HashMap<String, String> = HashMap::new();
    for (rec_id, enc_path) in zip_rows {
        if let (Some(rec_id), Some(enc_path)) = (rec_id, enc_path)
            && let Ok(dec) = state.config.field_key.decrypt(&enc_path)
            && !dec.is_empty()
        {
            zip_export_paths.insert(rec_id, dec);
        }
    }

    for i in 0..existing.len() {
        if existing[i].deleted_at.is_some()
            || existing[i].storage_type != "local"
            || !existing[i]
                .plaud_file_id
                .as_deref()
                .is_some_and(|f| f.starts_with("zip-"))
        {
            continue;
        }
        let exp_path = zip_export_paths.get(&existing[i].id).cloned();
        let exp_norm = exp_path.as_deref().map(|p| normalize_path(Path::new(p)));

        let dup_idx = (0..existing.len()).find(|&j| {
            if j == i {
                return false;
            }
            let r_dup = &existing[j];
            if r_dup.deleted_at.is_some()
                || r_dup.storage_type != "local_folder"
                || !r_dup
                    .plaud_file_id
                    .as_deref()
                    .is_some_and(|f| f.starts_with("folder-"))
            {
                return false;
            }
            let matches_export = match (&exp_path, &exp_norm) {
                (Some(ep), Some(en)) => {
                    r_dup.storage_path == *ep
                        || normalize_path(Path::new(&r_dup.storage_path)) == *en
                }
                _ => false,
            };
            let matches_content = is_in_folder(Path::new(&r_dup.storage_path), folder)
                && !existing[i].file_md5.is_empty()
                && existing[i].file_md5 == r_dup.file_md5
                && existing[i].filesize == r_dup.filesize;
            matches_export || matches_content
        });

        if let Some(j) = dup_idx {
            let zip_id = existing[i].id.clone();
            let old_local_path = existing[i].storage_path.clone();
            let dup_id = existing[j].id.clone();
            let dup_storage_path = existing[j].storage_path.clone();
            let dup_peaks = existing[j].waveform_peaks.clone();
            let adopt_dup_title = !matches!(existing[i].title_source.as_str(), "manual" | "ai")
                && matches!(existing[j].title_source.as_str(), "manual" | "ai");
            let new_filename = if adopt_dup_title {
                existing[j].filename.clone()
            } else {
                existing[i].filename.clone()
            };
            let new_title_source = if adopt_dup_title {
                existing[j].title_source.clone()
            } else {
                existing[i].title_source.clone()
            };

            let tx_count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM transcriptions WHERE recording_id = ?")
                    .bind(&zip_id)
                    .fetch_one(&state.db)
                    .await?;
            if tx_count == 0 {
                let _ = sqlx::query(
                    "UPDATE OR IGNORE transcriptions SET recording_id = ? WHERE recording_id = ?",
                )
                .bind(&zip_id)
                .bind(&dup_id)
                .execute(&state.db)
                .await;
            }
            let enh_count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM ai_enhancements WHERE recording_id = ?")
                    .bind(&zip_id)
                    .fetch_one(&state.db)
                    .await?;
            if enh_count == 0 {
                let _ = sqlx::query(
                    "UPDATE OR IGNORE ai_enhancements SET recording_id = ? WHERE recording_id = ?",
                )
                .bind(&zip_id)
                .bind(&dup_id)
                .execute(&state.db)
                .await;
            }
            let chat_count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM recording_chats WHERE recording_id = ?")
                    .bind(&zip_id)
                    .fetch_one(&state.db)
                    .await?;
            if chat_count == 0 {
                for sql in [
                    "UPDATE OR IGNORE recording_chats SET recording_id = ? WHERE recording_id = ?",
                    "UPDATE OR IGNORE recording_chat_turns SET recording_id = ? WHERE recording_id = ?",
                    "UPDATE OR IGNORE recording_chat_chunks SET recording_id = ? WHERE recording_id = ?",
                ] {
                    let _ = sqlx::query(sql)
                        .bind(&zip_id)
                        .bind(&dup_id)
                        .execute(&state.db)
                        .await;
                }
            }

            let now = now_ms();
            sqlx::query(
                "UPDATE recordings SET filename = ?, title_source = ?, storage_type = 'local_folder', \
                        storage_path = ?, waveform_peaks = COALESCE(waveform_peaks, ?), updated_at = ? \
                 WHERE id = ? AND user_id = ?",
            )
            .bind(&new_filename)
            .bind(&new_title_source)
            .bind(&dup_storage_path)
            .bind(&dup_peaks)
            .bind(now)
            .bind(&zip_id)
            .bind(user_id)
            .execute(&state.db)
            .await?;

            let _ = sqlx::query(
                "UPDATE zip_imports SET export_path = ? WHERE recording_id = ? AND user_id = ?",
            )
            .bind(state.config.field_key.encrypt(&dup_storage_path))
            .bind(&zip_id)
            .bind(user_id)
            .execute(&state.db)
            .await;
            zip_export_paths.insert(zip_id.clone(), dup_storage_path.clone());

            let _ = state.storage.delete("local", &old_local_path).await;

            let res = sqlx::query(
                "UPDATE recordings SET deleted_at = ?, updated_at = ? \
                 WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
            )
            .bind(now)
            .bind(now)
            .bind(&dup_id)
            .bind(user_id)
            .execute(&state.db)
            .await?;
            if res.rows_affected() > 0 {
                report.removed += 1;
            }

            existing[j].deleted_at = Some(now);
            existing[i].filename = new_filename;
            existing[i].title_source = new_title_source;
            existing[i].storage_type = "local_folder".to_owned();
            existing[i].storage_path = dup_storage_path;
            if existing[i].waveform_peaks.is_none() {
                existing[i].waveform_peaks = dup_peaks;
            }
        } else if let Some(exp_path) = exp_path
            && is_in_folder(Path::new(&exp_path), folder)
            && tokio::fs::try_exists(&exp_path).await.unwrap_or(false)
        {
            let now = now_ms();
            let old_local_path = existing[i].storage_path.clone();
            sqlx::query(
                "UPDATE recordings SET storage_type = 'local_folder', storage_path = ?, updated_at = ? \
                 WHERE id = ? AND user_id = ?",
            )
            .bind(&exp_path)
            .bind(now)
            .bind(&existing[i].id)
            .bind(user_id)
            .execute(&state.db)
            .await?;
            let _ = state.storage.delete("local", &old_local_path).await;
            existing[i].storage_type = "local_folder".to_owned();
            existing[i].storage_path = exp_path;
        }
    }

    let mut active_paths: HashSet<String> = HashSet::new();
    for r in existing.iter().filter(|r| r.deleted_at.is_none()) {
        insert_active_path(&mut active_paths, &r.storage_path);
        if let Some(enc) = r.auto_export_path.as_deref()
            && let Ok(dec) = state.config.field_key.decrypt(enc)
        {
            insert_active_path(&mut active_paths, &dec);
        }
        if let Some(enc) = r.auto_export_target.as_deref()
            && let Ok(dec) = state.config.field_key.decrypt(enc)
        {
            insert_active_path(&mut active_paths, &dec);
        }
        if r.storage_type != "local_folder"
            && let Some(exp) = zip_export_paths.get(&r.id)
        {
            insert_active_path(&mut active_paths, exp);
        }
    }

    let mut missing_rows: Vec<ExistingRow> = Vec::new();
    for row in &existing {
        if row.deleted_at.is_none()
            && row.storage_type == "local_folder"
            && is_in_folder(Path::new(&row.storage_path), folder)
            && !tokio::fs::try_exists(&row.storage_path)
                .await
                .unwrap_or(true)
        {
            missing_rows.push(row.clone());
        }
    }

    let mut candidates: Vec<Candidate> = Vec::new();
    let mut skipped_recent = false;
    while let Ok(Some(entry)) = read_dir.next_entry().await {
        let path = entry.path();
        let Some(file_name) = path.file_name().and_then(|n| n.to_str()).map(str::to_owned) else {
            continue;
        };
        if file_name.starts_with('.') {
            continue;
        }
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !ACCEPTED_AUDIO.contains(&ext.as_str()) {
            continue;
        }
        let Ok(metadata) = entry.metadata().await else {
            continue;
        };
        if !metadata.is_file() || metadata.len() == 0 {
            continue;
        }
        let file_path_str = path.to_string_lossy().into_owned();
        if active_paths.contains(&file_path_str) || active_paths.contains(&normalize_path(&path)) {
            continue;
        }
        if !manual
            && let Ok(modified) = metadata.modified()
            && let Ok(age) = SystemTime::now().duration_since(modified)
            && age < Duration::from_millis(800)
        {
            skipped_recent = true;
            continue;
        }
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(&file_name)
            .to_owned();
        let start_ms = match zip_merge::parse_segment_meta(&stem, 0)
            .map(|m| m.start_ms)
            .or_else(|| zip_merge::parse_generic_filename_timestamp(&stem).map(|m| m.start_ms))
            .or_else(|| parse_filename_date(&stem))
        {
            Some(ms) => ms,
            None => match zip_merge::probe_creation_time(&state.config.ffprobe, &path).await {
                Some(ms) => ms,
                None => metadata
                    .created()
                    .or_else(|_| metadata.modified())
                    .ok()
                    .and_then(zip_merge::system_time_ms)
                    .unwrap_or_else(now_ms),
            },
        };
        candidates.push(Candidate {
            path,
            file_path_str,
            file_name,
            stem,
            filesize: metadata.len() as i64,
            start_ms,
        });
    }

    candidates.sort_by(|a, b| {
        a.start_ms
            .cmp(&b.start_ms)
            .then_with(|| zip_merge::natural_cmp(&a.file_name, &b.file_name))
    });

    let mut prev_start_ms: Option<i64> = None;
    for candidate in &mut candidates {
        if let Some(prev) = prev_start_ms {
            candidate.start_ms = candidate.start_ms.max(prev + 1);
        }
        prev_start_ms = Some(candidate.start_ms);
    }

    let by_date = settings.get("recordingTitleMode").and_then(Value::as_str) == Some("date");
    let mut deferred_peaks: Vec<(String, PathBuf)> = Vec::new();
    for candidate in candidates {
        let Some(probe) = media::probe(&state.config.ffprobe, &candidate.path).await else {
            report
                .errors
                .push(format!("{}: unreadable audio", candidate.file_name));
            continue;
        };
        let file_md5 = match media::file_md5(&candidate.path).await {
            Ok(md5) => md5,
            Err(e) => {
                report.errors.push(format!("{}: {e}", candidate.file_name));
                continue;
            }
        };

        active_paths.insert(candidate.file_path_str.clone());
        active_paths.insert(normalize_path(&candidate.path));

        let id = ids::new_id();
        let (title, title_source) = if !candidate.stem.trim().is_empty() {
            (
                candidate.stem.trim().to_owned(),
                if by_date { "date" } else { "original" },
            )
        } else if by_date {
            let offset = recordings::local_offset_at(candidate.start_ms).await;
            (crate::time::local_date(candidate.start_ms, offset), "date")
        } else {
            (id.clone(), "original")
        };

        if let Some(pos) = missing_rows.iter().position(|m| {
            !file_md5.is_empty() && m.file_md5 == file_md5 && m.filesize == candidate.filesize
        }) {
            let m = missing_rows.remove(pos);
            let now = now_ms();
            if m.title_source != "manual" && m.title_source != "ai" {
                let enc_title = state.config.field_key.encrypt(&title);
                sqlx::query(
                    "UPDATE recordings SET storage_path = ?, filename = ?, title_source = ?, updated_at = ? \
                     WHERE id = ? AND user_id = ?",
                )
                .bind(&candidate.file_path_str)
                .bind(enc_title)
                .bind(title_source)
                .bind(now)
                .bind(&m.id)
                .bind(user_id)
                .execute(&state.db)
                .await?;
            } else {
                sqlx::query(
                    "UPDATE recordings SET storage_path = ?, updated_at = ? \
                     WHERE id = ? AND user_id = ?",
                )
                .bind(&candidate.file_path_str)
                .bind(now)
                .bind(&m.id)
                .bind(user_id)
                .execute(&state.db)
                .await?;
            }
            let _ = sqlx::query(
                "UPDATE zip_imports SET export_path = ? WHERE recording_id = ? AND user_id = ?",
            )
            .bind(state.config.field_key.encrypt(&candidate.file_path_str))
            .bind(&m.id)
            .bind(user_id)
            .execute(&state.db)
            .await;
            continue;
        }

        if let Some(z) = existing.iter_mut().find(|z| {
            z.deleted_at.is_none()
                && z.storage_type == "local"
                && z.plaud_file_id
                    .as_deref()
                    .is_some_and(|f| f.starts_with("zip-"))
                && !file_md5.is_empty()
                && z.file_md5 == file_md5
                && z.filesize == candidate.filesize
        }) {
            let now = now_ms();
            let old_local_path = z.storage_path.clone();
            sqlx::query(
                "UPDATE recordings SET storage_type = 'local_folder', storage_path = ?, updated_at = ? \
                 WHERE id = ? AND user_id = ?",
            )
            .bind(&candidate.file_path_str)
            .bind(now)
            .bind(&z.id)
            .bind(user_id)
            .execute(&state.db)
            .await?;
            let _ = sqlx::query(
                "UPDATE zip_imports SET export_path = ? WHERE recording_id = ? AND user_id = ?",
            )
            .bind(state.config.field_key.encrypt(&candidate.file_path_str))
            .bind(&z.id)
            .bind(user_id)
            .execute(&state.db)
            .await;
            let _ = state.storage.delete("local", &old_local_path).await;
            z.storage_type = "local_folder".to_owned();
            z.storage_path = candidate.file_path_str.clone();
            continue;
        }

        let inline_peaks = candidate.filesize <= 15 * 1024 * 1024;
        let peaks = if inline_peaks {
            media::compute_peaks(&state.config.ffmpeg, &candidate.path, 256)
                .await
                .and_then(|p| serde_json::to_string(&p).ok())
        } else {
            None
        };
        let plaud_file_id = format!("folder-{id}");

        if let Err(e) = recordings::insert(
            &state.db,
            &state.config.field_key,
            recordings::NewRecording {
                id: &id,
                user_id,
                plaud_file_id: &plaud_file_id,
                title: &title,
                duration: probe.duration_ms,
                start: candidate.start_ms,
                filesize: candidate.filesize,
                file_md5: &file_md5,
                storage_type: "local_folder",
                storage_path: &candidate.file_path_str,
                title_source,
                auto_export_eligible: false,
                waveform_peaks: peaks.as_deref(),
            },
        )
        .await
        {
            report
                .errors
                .push(format!("{}: {}", candidate.file_name, e.message));
            continue;
        }

        if !inline_peaks {
            deferred_peaks.push((id.clone(), candidate.path.clone()));
        }
        if let Err(e) = crate::transcribe::queue_auto(state, user_id, &id).await {
            tracing::warn!(recording = %id, error = %e.message, "queueing automatic transcription for folder recording failed");
        }
        report.synced += 1;
    }

    if !skipped_recent {
        for row in missing_rows {
            let now = now_ms();
            let res = sqlx::query(
                "UPDATE recordings SET deleted_at = ?, updated_at = ? \
                 WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
            )
            .bind(now)
            .bind(now)
            .bind(&row.id)
            .bind(user_id)
            .execute(&state.db)
            .await?;
            if res.rows_affected() > 0 {
                report.removed += 1;
            }
        }
    }

    if !deferred_peaks.is_empty() {
        let bg_state = state.clone();
        tokio::spawn(async move {
            for (rec_id, path) in deferred_peaks {
                if let Some(peaks) = media::compute_peaks(&bg_state.config.ffmpeg, &path, 256).await
                    && let Ok(peaks_json) = serde_json::to_string(&peaks)
                {
                    let _ = sqlx::query(
                        "UPDATE recordings SET waveform_peaks = ?, updated_at = ? \
                         WHERE id = ? AND waveform_peaks IS NULL",
                    )
                    .bind(peaks_json)
                    .bind(now_ms())
                    .bind(&rec_id)
                    .execute(&bg_state.db)
                    .await;
                }
            }
        });
    }

    Ok(report)
}

/// Parses a `YYYY-MM-DD` date token in the filename stem as 12:00:00 UTC on that date.
fn parse_filename_date(stem: &str) -> Option<i64> {
    let bytes = stem.as_bytes();
    for i in 0..bytes.len() {
        if i > 0 && bytes[i - 1].is_ascii_digit() {
            continue;
        }
        if i + 10 <= bytes.len()
            && bytes[i..i + 4].iter().all(u8::is_ascii_digit)
            && bytes[i + 4] == b'-'
            && bytes[i + 5..i + 7].iter().all(u8::is_ascii_digit)
            && bytes[i + 7] == b'-'
            && bytes[i + 8..i + 10].iter().all(u8::is_ascii_digit)
            && (i + 10 == bytes.len() || !bytes[i + 10].is_ascii_digit())
        {
            let year: i32 = stem[i..i + 4].parse().ok()?;
            let month_num: u8 = stem[i + 5..i + 7].parse().ok()?;
            let day: u8 = stem[i + 8..i + 10].parse().ok()?;
            let month = ::time::Month::try_from(month_num).ok()?;
            let date = ::time::Date::from_calendar_date(year, month, day).ok()?;
            let dt = date.with_hms(12, 0, 0).ok()?.assume_utc();
            return i64::try_from(dt.unix_timestamp_nanos() / 1_000_000).ok();
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::process::Command;

    async fn make_tone(ffmpeg: &Path, dst: &Path, freq: u32) {
        let mut cmd = Command::new(ffmpeg);
        cmd.args([
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            &format!("sine=frequency={freq}:sample_rate=16000:duration=1"),
            "-c:a",
            "aac",
            "-b:a",
            "64k",
            "-f",
            "ipod",
        ])
        .arg(dst);
        assert!(media::run(&mut cmd).await);
    }

    #[tokio::test]
    async fn syncs_chronologically_and_soft_deletes_missing_files() {
        let dir = tempfile::tempdir().unwrap();
        let folder = tempfile::tempdir().unwrap();
        let config = crate::Config::for_tests(dir.path());
        let state = AppState::new(config, crate::db::open_memory().await.unwrap());
        sqlx::query(
            "INSERT INTO users (id, email, created_at, updated_at) VALUES ('u', 'u@example.test', 0, 0)",
        )
        .execute(&state.db)
        .await
        .unwrap();
        sqlx::query("INSERT INTO user_settings (user_id, data, updated_at) VALUES ('u', ?, 0)")
            .bind(
                json!({
                    "localStorageFolder": folder.path().to_string_lossy(),
                    "recordingTitleMode": "original",
                })
                .to_string(),
            )
            .execute(&state.db)
            .await
            .unwrap();

        let later = folder
            .path()
            .join("Rec_2026-10-29_14-00-00_to_15-00-00_UTC+0000.m4a");
        let earlier = folder
            .path()
            .join("Rec_2026-10-29_10-00-00_to_11-00-00_UTC+0000.m4a");
        make_tone(&state.config.ffmpeg, &later, 440).await;
        make_tone(&state.config.ffmpeg, &earlier, 880).await;

        let settings = effective(&state, "u").await.unwrap();
        let r1 = sync_user(&state, "u", folder.path(), &settings, true)
            .await
            .unwrap();
        assert_eq!(r1.synced, 2);
        assert_eq!(r1.removed, 0);
        assert!(r1.errors.is_empty());

        let rows: Vec<(String, i64, Option<String>)> = sqlx::query_as(
            "SELECT storage_path, start_time, waveform_peaks FROM recordings WHERE user_id = 'u' AND deleted_at IS NULL ORDER BY start_time ASC",
        )
        .fetch_all(&state.db)
        .await
        .unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].0, earlier.to_string_lossy());
        assert_eq!(rows[1].0, later.to_string_lossy());
        assert!(rows[0].1 < rows[1].1);
        assert!(rows[0].2.is_some());

        std::fs::remove_file(&earlier).unwrap();
        let r2 = sync_user(&state, "u", folder.path(), &settings, true)
            .await
            .unwrap();
        assert_eq!(r2.synced, 0);
        assert_eq!(r2.removed, 1);

        let remaining: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM recordings WHERE user_id = 'u' AND deleted_at IS NULL",
        )
        .fetch_one(&state.db)
        .await
        .unwrap();
        assert_eq!(remaining, 1);
    }

    #[tokio::test]
    async fn renaming_file_in_folder_updates_recording_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let folder = tempfile::tempdir().unwrap();
        let config = crate::Config::for_tests(dir.path());
        let state = AppState::new(config, crate::db::open_memory().await.unwrap());
        sqlx::query(
            "INSERT INTO users (id, email, created_at, updated_at) VALUES ('u', 'u@example.test', 0, 0)",
        )
        .execute(&state.db)
        .await
        .unwrap();
        sqlx::query("INSERT INTO user_settings (user_id, data, updated_at) VALUES ('u', ?, 0)")
            .bind(
                json!({
                    "localStorageFolder": folder.path().to_string_lossy(),
                    "recordingTitleMode": "original",
                })
                .to_string(),
            )
            .execute(&state.db)
            .await
            .unwrap();

        let orig = folder.path().join("Original_Name.m4a");
        make_tone(&state.config.ffmpeg, &orig, 440).await;

        let settings = effective(&state, "u").await.unwrap();
        let r1 = sync_user(&state, "u", folder.path(), &settings, true)
            .await
            .unwrap();
        assert_eq!(r1.synced, 1);
        assert_eq!(r1.removed, 0);

        let (orig_id, orig_path, orig_enc_title): (String, String, String) = sqlx::query_as(
            "SELECT id, storage_path, filename FROM recordings WHERE user_id = 'u' AND deleted_at IS NULL",
        )
        .fetch_one(&state.db)
        .await
        .unwrap();
        assert_eq!(orig_path, orig.to_string_lossy());
        assert_eq!(
            state.config.field_key.decrypt(&orig_enc_title).unwrap(),
            "Original_Name"
        );

        let renamed = folder.path().join("Renamed_Recording.m4a");
        std::fs::rename(&orig, &renamed).unwrap();

        let r2 = sync_user(&state, "u", folder.path(), &settings, true)
            .await
            .unwrap();
        assert_eq!(r2.synced, 0);
        assert_eq!(r2.removed, 0);
        assert!(r2.errors.is_empty());

        let rows: Vec<(String, String, String)> =
            sqlx::query_as("SELECT id, storage_path, filename FROM recordings WHERE user_id = 'u'")
                .fetch_all(&state.db)
                .await
                .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].0, orig_id);
        assert_eq!(rows[0].1, renamed.to_string_lossy());
        assert_eq!(
            state.config.field_key.decrypt(&rows[0].2).unwrap(),
            "Renamed_Recording"
        );
    }

    #[tokio::test]
    async fn heals_existing_zip_and_folder_duplicate_pair() {
        let dir = tempfile::tempdir().unwrap();
        let folder = tempfile::tempdir().unwrap();
        let config = crate::Config::for_tests(dir.path());
        let state = AppState::new(config, crate::db::open_memory().await.unwrap());
        sqlx::query(
            "INSERT INTO users (id, email, created_at, updated_at) VALUES ('u', 'u@example.test', 0, 0)",
        )
        .execute(&state.db)
        .await
        .unwrap();
        sqlx::query("INSERT INTO user_settings (user_id, data, updated_at) VALUES ('u', ?, 0)")
            .bind(
                json!({
                    "localStorageFolder": folder.path().to_string_lossy(),
                    "recordingTitleMode": "original",
                })
                .to_string(),
            )
            .execute(&state.db)
            .await
            .unwrap();

        let folder_file = folder.path().join("2026-10-29_10-00-00.m4a");
        make_tone(&state.config.ffmpeg, &folder_file, 440).await;
        let md5 = media::file_md5(&folder_file).await.unwrap();
        let filesize = std::fs::metadata(&folder_file).unwrap().len() as i64;
        let folder_file_str = folder_file.to_string_lossy().into_owned();

        recordings::insert(
            &state.db,
            &state.config.field_key,
            recordings::NewRecording {
                id: "zip-rec",
                user_id: "u",
                plaud_file_id: "zip-123",
                title: "Zip Imported Title",
                duration: 1000,
                start: 1_700_000_000_000,
                filesize,
                file_md5: &md5,
                storage_type: "local",
                storage_path: "u/zip-rec.m4a",
                title_source: "original",
                auto_export_eligible: false,
                waveform_peaks: None,
            },
        )
        .await
        .unwrap();

        recordings::insert(
            &state.db,
            &state.config.field_key,
            recordings::NewRecording {
                id: "folder-rec",
                user_id: "u",
                plaud_file_id: "folder-456",
                title: "2026-10-29_10-00-00",
                duration: 1000,
                start: 1_700_000_000_000,
                filesize,
                file_md5: &md5,
                storage_type: "local_folder",
                storage_path: &folder_file_str,
                title_source: "original",
                auto_export_eligible: false,
                waveform_peaks: Some("[0.5]"),
            },
        )
        .await
        .unwrap();

        let settings = effective(&state, "u").await.unwrap();
        let report = sync_user(&state, "u", folder.path(), &settings, true)
            .await
            .unwrap();
        assert_eq!(report.synced, 0);
        assert_eq!(report.removed, 1);
        assert!(report.errors.is_empty());
        assert!(folder_file.exists());

        let active: Vec<(String, String, String, Option<String>)> = sqlx::query_as(
            "SELECT id, storage_type, storage_path, waveform_peaks FROM recordings WHERE user_id = 'u' AND deleted_at IS NULL",
        )
        .fetch_all(&state.db)
        .await
        .unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].0, "zip-rec");
        assert_eq!(active[0].1, "local_folder");
        assert_eq!(active[0].2, folder_file_str);
        assert_eq!(active[0].3.as_deref(), Some("[0.5]"));

        let dup_deleted: Option<i64> =
            sqlx::query_scalar("SELECT deleted_at FROM recordings WHERE id = 'folder-rec'")
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert!(dup_deleted.is_some());
    }
}
