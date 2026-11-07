//! Custom local storage folder sync (`/api/settings/storage/sync`) and background watcher.

use std::collections::HashSet;
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

#[derive(sqlx::FromRow)]
struct ExistingRow {
    id: String,
    storage_type: String,
    storage_path: String,
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

    let existing: Vec<ExistingRow> = sqlx::query_as(
        "SELECT id, storage_type, storage_path, deleted_at FROM recordings WHERE user_id = ?",
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await?;

    for row in &existing {
        if row.deleted_at.is_none()
            && row.storage_type == "local_folder"
            && Path::new(&row.storage_path).parent() == Some(folder)
            && !tokio::fs::try_exists(&row.storage_path)
                .await
                .unwrap_or(true)
        {
            let now = now_ms();
            let res = sqlx::query(
                "UPDATE recordings SET deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
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

    let active_paths: HashSet<&str> = existing
        .iter()
        .filter(|r| r.deleted_at.is_none())
        .map(|r| r.storage_path.as_str())
        .collect();

    let mut candidates: Vec<Candidate> = Vec::new();
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
        if !manual
            && let Ok(modified) = metadata.modified()
            && let Ok(age) = SystemTime::now().duration_since(modified)
            && age < Duration::from_millis(800)
        {
            continue;
        }
        let file_path_str = path.to_string_lossy().into_owned();
        if active_paths.contains(file_path_str.as_str()) {
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
        let inline_peaks = candidate.filesize <= 15 * 1024 * 1024;
        let peaks = if inline_peaks {
            media::compute_peaks(&state.config.ffmpeg, &candidate.path, 256)
                .await
                .and_then(|p| serde_json::to_string(&p).ok())
        } else {
            None
        };
        let id = ids::new_id();
        let plaud_file_id = format!("folder-{id}");
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
}
