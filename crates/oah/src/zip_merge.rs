//! Automatic unpacking, chronological merging, library import, and export of segmented `.zip` audio archives.
//! Rules are in spec/export.md and spec/settings.md.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::LazyLock;
use std::time::{Duration, SystemTime};

use axum::body::Bytes;
use axum::extract::State;
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use sha2::Digest;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::{Mutex, Notify};

use crate::AppState;
use crate::auth::CurrentUser;
use crate::db::now_ms;
use crate::error::{ApiResult, AppError};
use crate::ids;
use crate::routes::recordings::{self, media};
use crate::routes::settings::effective;

const TICK: Duration = Duration::from_secs(15);
const MAX_MERGE_MS: i64 = 24 * 60 * 60 * 1000;
const ACCEPTED_AUDIO: &[&str] = &[
    "m4a", "mp4", "aac", "mp3", "wav", "ogg", "opus", "flac", "webm",
];

static SCAN_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
static WAKE: LazyLock<Notify> = LazyLock::new(Notify::new);

pub fn router() -> Router<AppState> {
    Router::new().route("/api/zip/merge", post(merge_route))
}

/// Wakes the background loop so a settings change or a new AI title takes effect at once.
pub fn notify() {
    WAKE.notify_one();
}

/// Starts the background `.zip` watch loop in the desktop build.
pub fn spawn(state: &AppState) {
    if state.config.desktop.is_none() {
        return;
    }
    let state = state.clone();
    tokio::spawn(async move {
        loop {
            if let Err(e) = auto_pass(&state).await {
                tracing::warn!(error = %e.message, "zip auto-merge background pass failed");
            }
            tokio::select! {
                _ = tokio::time::sleep(TICK) => {}
                _ = WAKE.notified() => {}
            }
        }
    });
}

/// How `POST /api/zip/merge` handles `.zip` archives that have already been merged before.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DuplicateAction {
    /// Merge unmerged `.zip` files immediately and report already-merged filenames in `alreadyMerged`.
    #[default]
    Ask,
    /// Skip already-merged `.zip` files.
    Skip,
    /// Replace the previous Library recording and exported `.m4a` file for already-merged `.zip` files.
    Replace,
    /// Keep the existing Library recording and exported `.m4a` file, and merge again as a new copy.
    KeepBoth,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeRequest {
    #[serde(default)]
    pub duplicate_action: DuplicateAction,
    #[serde(default)]
    pub only_files: Option<Vec<String>>,
}

#[derive(Default)]
pub struct ScanReport {
    pub merged: u32,
    pub skipped: u32,
    pub already_merged: Vec<String>,
    pub errors: Vec<String>,
}

async fn merge_route(
    State(state): State<AppState>,
    user: CurrentUser,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    if state.config.desktop.is_none() {
        return Err(AppError::bad_request(
            "INVALID_INPUT",
            "ZIP folder merge is only available in the desktop app",
        )
        .detail("field", "zipWatchFolder"));
    }
    let req: MergeRequest = if body.is_empty() {
        MergeRequest::default()
    } else {
        serde_json::from_slice(&body).unwrap_or_default()
    };
    let settings = effective(&state, &user.id).await?;
    let Some(watch_folder) = settings
        .get("zipWatchFolder")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
    else {
        return Err(AppError::bad_request(
            "INVALID_INPUT",
            "Choose a ZIP watch folder in the desktop app first",
        )
        .detail("field", "zipWatchFolder"));
    };
    let report = scan_user_with_options(
        &state,
        &user.id,
        &watch_folder,
        &settings,
        true,
        req.duplicate_action,
        req.only_files.as_deref(),
    )
    .await?;
    Ok(Json(json!({
        "success": true,
        "merged": report.merged,
        "skipped": report.skipped,
        "alreadyMerged": report.already_merged,
        "errors": report.errors,
    })))
}

async fn auto_pass(state: &AppState) -> ApiResult<()> {
    let users: Vec<String> = sqlx::query_scalar(
        "SELECT user_id FROM user_settings WHERE json_extract(data, '$.zipAutoMerge') = 1 OR json_extract(data, '$.zipTitleMode') = 'ai'",
    )
    .fetch_all(&state.db)
    .await?;
    for user_id in users {
        let settings = effective(state, &user_id).await?;
        let auto_merge = settings.get("zipAutoMerge") == Some(&Value::Bool(true));
        let watch_folder = settings
            .get("zipWatchFolder")
            .and_then(Value::as_str)
            .filter(|f| !f.is_empty())
            .map(PathBuf::from);
        if auto_merge {
            if let Some(watch_folder) = watch_folder
                && let Err(e) = scan_user(state, &user_id, &watch_folder, &settings).await
            {
                tracing::warn!(user = %user_id, error = %e.message, "zip auto-merge pass failed for user");
            }
        } else if settings.get("zipTitleMode").and_then(Value::as_str) == Some("ai") {
            let export_folder = settings
                .get("zipExportFolder")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(PathBuf::from)
                .or(watch_folder);
            if let Some(export_folder) = export_folder {
                let _guard = SCAN_LOCK.lock().await;
                let _ = rename_ai_exports(state, &user_id, &export_folder).await;
            }
        }
    }
    Ok(())
}

/// Runs one background scan pass for `user_id`, skipping already-merged archives.
pub async fn scan_user(
    state: &AppState,
    user_id: &str,
    watch_folder: &Path,
    settings: &Map<String, Value>,
) -> ApiResult<ScanReport> {
    scan_user_with_options(
        state,
        user_id,
        watch_folder,
        settings,
        false,
        DuplicateAction::Skip,
        None,
    )
    .await
}

/// Runs one scan pass for `user_id`, serialized across background and manual triggers.
pub async fn scan_user_with_options(
    state: &AppState,
    user_id: &str,
    watch_folder: &Path,
    settings: &Map<String, Value>,
    immediate: bool,
    duplicate_action: DuplicateAction,
    only_files: Option<&[String]>,
) -> ApiResult<ScanReport> {
    let _guard = SCAN_LOCK.lock().await;
    let export_folder = settings
        .get("zipExportFolder")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| watch_folder.to_path_buf());
    let local_storage_folder = if state.storage.active_type() == "local" {
        settings
            .get("localStorageFolder")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
    } else {
        None
    };
    let title_mode = settings
        .get("zipTitleMode")
        .and_then(Value::as_str)
        .unwrap_or("original");
    let delete_zip = settings.get("zipDeleteAfterMerge") == Some(&Value::Bool(true));

    if title_mode == "ai" {
        let _ = rename_ai_exports(state, user_id, &export_folder).await;
    }

    let mut read_dir = match tokio::fs::read_dir(watch_folder).await {
        Ok(rd) => rd,
        Err(e) => {
            return Err(AppError::bad_request(
                "INVALID_INPUT",
                format!("Could not read ZIP watch folder: {e}"),
            )
            .detail("field", "zipWatchFolder"));
        }
    };

    let mut zips: Vec<PathBuf> = Vec::new();
    while let Ok(Some(entry)) = read_dir.next_entry().await {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if name.starts_with('.') {
            continue;
        }
        if let Some(filter) = only_files
            && !filter.iter().any(|f| f == name)
        {
            continue;
        }
        if !path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("zip"))
        {
            continue;
        }
        let Ok(meta) = entry.metadata().await else {
            continue;
        };
        if !meta.is_file() || meta.len() == 0 {
            continue;
        }
        // During background scans, skip a file modified in the last 800 ms so an active copy or sync settles first.
        if !immediate
            && let Ok(modified) = meta.modified()
            && let Ok(age) = SystemTime::now().duration_since(modified)
            && age < Duration::from_millis(800)
        {
            continue;
        }
        zips.push(path);
    }
    zips.sort();

    let mut report = ScanReport::default();
    for zip_path in zips {
        let zip_name = zip_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("archive.zip")
            .to_owned();
        match process_zip(
            state,
            user_id,
            &zip_path,
            &export_folder,
            local_storage_folder.as_deref(),
            title_mode,
            delete_zip,
            duplicate_action,
        )
        .await
        {
            Ok(ZipOutcome::Merged) => report.merged += 1,
            Ok(ZipOutcome::Skipped) => report.skipped += 1,
            Ok(ZipOutcome::AlreadyMerged) => {
                report.skipped += 1;
                report.already_merged.push(zip_name);
            }
            Err(err) => {
                tracing::warn!(archive = %zip_name, error = %err, "zip archive merge failed");
                report.errors.push(format!("{zip_name}: {err}"));
            }
        }
    }

    if title_mode == "ai" {
        let _ = rename_ai_exports(state, user_id, &export_folder).await;
    }

    Ok(report)
}

enum ZipOutcome {
    Merged,
    Skipped,
    AlreadyMerged,
}

/// Parsed timestamp and label metadata from an audio segment filename.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SegmentMeta {
    pub start_date: String,
    pub start_time: String,
    pub end_date: String,
    pub end_time: String,
    pub offset: ::time::UtcOffset,
    pub start_ms: i64,
}

/// Parses timestamps from a segment filename:
/// 1. `<Prefix>_YYYY-MM-DD_HH-MM-SS_to_[YYYY-MM-DD_]HH-MM-SS[_UTC±HHMM].<ext>` (or without prefix)
/// 2. Standalone `YYYY-MM-DD[_T ]HH[-:]MM[-:]SS` or `YYYYMMDD[_-]HHMMSS` anywhere in the filename stem
pub fn parse_segment_filename(file_name: &str) -> Option<SegmentMeta> {
    let base = file_name.rsplit(['/', '\\']).next().unwrap_or(file_name);
    let stem = match base.rsplit_once('.') {
        Some((s, _)) => s,
        None => base,
    };
    if let Some(meta) = parse_range_stem(stem) {
        return Some(meta);
    }
    parse_single_timestamp_stem(stem)
}

pub(crate) fn parse_segment_meta(stem: &str, _fallback_offset_mins: i64) -> Option<SegmentMeta> {
    parse_range_stem(stem)
}

pub(crate) fn parse_generic_filename_timestamp(stem: &str) -> Option<SegmentMeta> {
    parse_single_timestamp_stem(stem)
}

pub(crate) fn system_time_ms(t: SystemTime) -> Option<i64> {
    let dur = t.duration_since(SystemTime::UNIX_EPOCH).ok()?;
    let ms = i64::try_from(dur.as_millis()).ok()?;
    (ms > 0).then_some(ms)
}

fn parse_range_stem(stem: &str) -> Option<SegmentMeta> {
    let (range_part, offset) = match stem.rsplit_once("_UTC") {
        Some((r, off)) => (r, parse_utc_offset(off)?),
        None => (stem, ::time::UtcOffset::UTC),
    };
    let (before_to, end_part) = range_part.split_once("_to_")?;
    if before_to.len() < 19 {
        return None;
    }
    let start_token = &before_to[before_to.len() - 19..];
    let (start_date, start_time) = start_token.split_once('_')?;
    if !is_date_token(start_date) || !is_time_token(start_time) {
        return None;
    }
    let (end_date, end_time) = match end_part.split_once('_') {
        Some((d, t)) if is_date_token(d) && is_time_token(t) => (d.to_owned(), t.to_owned()),
        None if is_time_token(end_part) => (start_date.to_owned(), end_part.to_owned()),
        _ => return None,
    };
    let start_ms = date_time_to_ms(start_date, start_time, offset)?;
    Some(SegmentMeta {
        start_date: start_date.to_owned(),
        start_time: start_time.to_owned(),
        end_date,
        end_time,
        offset,
        start_ms,
    })
}

fn parse_single_timestamp_stem(stem: &str) -> Option<SegmentMeta> {
    let bytes = stem.as_bytes();
    if bytes.len() >= 19 {
        for i in 0..=bytes.len() - 19 {
            let Some(sub) = stem.get(i..i + 19) else {
                continue;
            };
            let sep = sub.as_bytes()[10];
            if !matches!(sep, b'_' | b'T' | b' ' | b'-') {
                continue;
            }
            let date_part = &sub[0..10];
            let time_part = sub[11..19].replace(':', "-");
            if is_date_token(date_part)
                && is_time_token(&time_part)
                && let Some(start_ms) =
                    date_time_to_ms(date_part, &time_part, ::time::UtcOffset::UTC)
            {
                return Some(SegmentMeta {
                    start_date: date_part.to_owned(),
                    start_time: time_part.clone(),
                    end_date: date_part.to_owned(),
                    end_time: time_part,
                    offset: ::time::UtcOffset::UTC,
                    start_ms,
                });
            }
        }
    }
    if bytes.len() >= 15 {
        for i in 0..=bytes.len() - 15 {
            let Some(sub) = stem.get(i..i + 15) else {
                continue;
            };
            let sep = sub.as_bytes()[8];
            if !matches!(sep, b'_' | b'-' | b'T') {
                continue;
            }
            if !sub[0..8].bytes().all(|b| b.is_ascii_digit())
                || !sub[9..15].bytes().all(|b| b.is_ascii_digit())
            {
                continue;
            }
            let date_part = format!("{}-{}-{}", &sub[0..4], &sub[4..6], &sub[6..8]);
            let time_part = format!("{}-{}-{}", &sub[9..11], &sub[11..13], &sub[13..15]);
            if let Some(start_ms) = date_time_to_ms(&date_part, &time_part, ::time::UtcOffset::UTC)
            {
                return Some(SegmentMeta {
                    start_date: date_part.clone(),
                    start_time: time_part.clone(),
                    end_date: date_part,
                    end_time: time_part,
                    offset: ::time::UtcOffset::UTC,
                    start_ms,
                });
            }
        }
    }
    None
}

fn is_date_token(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

fn is_time_token(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 8
        && b[2] == b'-'
        && b[5] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 2 || i == 5 || c.is_ascii_digit())
}

fn parse_utc_offset(s: &str) -> Option<::time::UtcOffset> {
    let trimmed = s.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("Z") {
        return Some(::time::UtcOffset::UTC);
    }
    let (sign, digits) = match trimmed.as_bytes().first()? {
        b'+' => (1i8, &trimmed[1..]),
        b'-' => (-1i8, &trimmed[1..]),
        _ => return None,
    };
    let clean = digits.replace(':', "");
    if clean.len() != 4 {
        return None;
    }
    let hours: i8 = clean[..2].parse().ok()?;
    let mins: i8 = clean[2..].parse().ok()?;
    ::time::UtcOffset::from_hms(sign * hours, sign * mins, 0).ok()
}

fn date_time_to_ms(date: &str, time: &str, offset: ::time::UtcOffset) -> Option<i64> {
    let year: i32 = date[0..4].parse().ok()?;
    let month_num: u8 = date[5..7].parse().ok()?;
    let day: u8 = date[8..10].parse().ok()?;
    let hour: u8 = time[0..2].parse().ok()?;
    let minute: u8 = time[3..5].parse().ok()?;
    let second: u8 = time[6..8].parse().ok()?;
    let month = ::time::Month::try_from(month_num).ok()?;
    let d = ::time::Date::from_calendar_date(year, month, day).ok()?;
    let t = ::time::Time::from_hms(hour, minute, second).ok()?;
    let odt = ::time::PrimitiveDateTime::new(d, t).assume_offset(offset);
    i64::try_from(odt.unix_timestamp_nanos() / 1_000_000).ok()
}

/// Parses `Export-notes.txt` to find the earliest UTC timestamp recorded for each audio file.
/// Supports both `[filename.m4a]\n  file +0.000s | 2026-10-30T21:52:19Z – ...` section blocks
/// and `filename.m4a | file +0.000s | 2026-10-30T21:52:19Z - ...` single-line entries.
pub fn parse_export_notes(text: &str) -> HashMap<String, i64> {
    let mut map = HashMap::new();
    let mut current_section_file: Option<String> = None;

    for raw_line in text.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with('[')
            && line.ends_with(']')
            && line.len() > 2
            && !line.starts_with("[Export ")
        {
            let name = line[1..line.len() - 1].trim();
            let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
            let ext = Path::new(base)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if ACCEPTED_AUDIO.contains(&ext.as_str()) {
                current_section_file = Some(base.to_owned());
                continue;
            }
        }

        let parts: Vec<&str> = line.split('|').map(str::trim).collect();
        let (file_name, range_part) = match parts.as_slice() {
            [file_part, _offset_part, range] if !file_part.is_empty() => {
                let base = file_part
                    .rsplit(['/', '\\'])
                    .next()
                    .unwrap_or(file_part)
                    .to_owned();
                (Some(base), *range)
            }
            [_offset_part, range] => (current_section_file.clone(), *range),
            _ => continue,
        };
        let Some(base) = file_name else {
            continue;
        };
        let first_iso = range_part
            .split(['–', '—', ' '])
            .map(str::trim)
            .find(|s| !s.is_empty() && s.contains('T'));
        if let Some(iso_str) = first_iso
            && let Some(ms) = crate::time::parse_iso(iso_str)
        {
            map.entry(base)
                .and_modify(|existing: &mut i64| {
                    if ms < *existing {
                        *existing = ms;
                    }
                })
                .or_insert(ms);
        }
    }
    map
}

/// Builds the `original` title from the ordered segments, or falls back to the archive stem.
/// Same-day: `YYYY-MM-DD_HH-MM-SS_to_HH-MM-SS`
/// Cross-day: `YYYY-MM-DD_HH-MM-SS_to_YYYY-MM-DD_HH-MM-SS`
pub fn original_title(segments: &[ExtractedSegment], zip_stem: &str) -> String {
    if let (Some(first), Some(last)) = (
        segments.first().and_then(|s| s.meta.as_ref()),
        segments.last().and_then(|s| s.meta.as_ref()),
    ) {
        if first.start_date == last.end_date {
            return format!(
                "{}_{}_to_{}",
                first.start_date, first.start_time, last.end_time
            );
        }
        return format!(
            "{}_{}_to_{}_{}",
            first.start_date, first.start_time, last.end_date, last.end_time
        );
    }
    if zip_stem.trim().is_empty() {
        "Merged_Recording".to_owned()
    } else {
        zip_stem.trim().to_owned()
    }
}

#[derive(Debug, Clone)]
pub struct ExtractedSegment {
    pub basename: String,
    pub path: PathBuf,
    pub meta: Option<SegmentMeta>,
    pub notes_start_ms: Option<i64>,
    pub container_start_ms: Option<i64>,
    pub zip_mtime_ms: Option<i64>,
}

impl ExtractedSegment {
    /// Primary chronological timestamp used to order segments:
    /// 1. `Export-notes.txt` earliest UTC start timestamp or filename timestamp
    /// 2. Audio container `creation_time` metadata tag
    /// 3. ZIP entry `last_modified` timestamp (when > 1980)
    pub fn sort_timestamp(&self) -> i64 {
        self.meta
            .as_ref()
            .map(|m| m.start_ms)
            .or(self.notes_start_ms)
            .or(self.container_start_ms)
            .or(self.zip_mtime_ms)
            .unwrap_or(i64::MAX)
    }

    /// Exact start instant of the first recorded audio in this segment.
    pub fn recording_start_ms(&self) -> Option<i64> {
        self.notes_start_ms
            .or_else(|| self.meta.as_ref().map(|m| m.start_ms))
            .or(self.container_start_ms)
            .or(self.zip_mtime_ms)
    }
}

/// Natural string comparison that compares contiguous ASCII digit runs by numeric value.
pub(crate) fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let mut ia = a.as_bytes().iter().peekable();
    let mut ib = b.as_bytes().iter().peekable();

    loop {
        match (ia.peek(), ib.peek()) {
            (None, None) => return std::cmp::Ordering::Equal,
            (None, Some(_)) => return std::cmp::Ordering::Less,
            (Some(_), None) => return std::cmp::Ordering::Greater,
            (Some(&&ca), Some(&&cb)) => {
                if ca.is_ascii_digit() && cb.is_ascii_digit() {
                    let mut na: u128 = 0;
                    let mut len_a = 0usize;
                    while let Some(&&d) = ia.peek() {
                        if !d.is_ascii_digit() {
                            break;
                        }
                        na = na.saturating_mul(10).saturating_add(u128::from(d - b'0'));
                        len_a += 1;
                        ia.next();
                    }
                    let mut nb: u128 = 0;
                    let mut len_b = 0usize;
                    while let Some(&&d) = ib.peek() {
                        if !d.is_ascii_digit() {
                            break;
                        }
                        nb = nb.saturating_mul(10).saturating_add(u128::from(d - b'0'));
                        len_b += 1;
                        ib.next();
                    }
                    match na.cmp(&nb).then_with(|| len_a.cmp(&len_b)) {
                        std::cmp::Ordering::Equal => continue,
                        non_eq => return non_eq,
                    }
                }
                let cmp = ca
                    .to_ascii_lowercase()
                    .cmp(&cb.to_ascii_lowercase())
                    .then_with(|| ca.cmp(&cb));
                if cmp != std::cmp::Ordering::Equal {
                    return cmp;
                }
                ia.next();
                ib.next();
            }
        }
    }
}

/// Orders segments chronologically by parsed start timestamp, then by notes timestamp, then by natural filename order.
pub fn sort_segments(segments: &mut [ExtractedSegment]) {
    segments.sort_by(|a, b| {
        a.sort_timestamp()
            .cmp(&b.sort_timestamp())
            .then_with(|| {
                a.notes_start_ms
                    .unwrap_or(i64::MAX)
                    .cmp(&b.notes_start_ms.unwrap_or(i64::MAX))
            })
            .then_with(|| natural_cmp(&a.basename, &b.basename))
    });
}

pub(crate) async fn probe_creation_time(ffprobe: &Path, file: &Path) -> Option<i64> {
    probe_creation_time_ms(ffprobe, file).await
}

async fn probe_creation_time_ms(ffprobe: &Path, file: &Path) -> Option<i64> {
    let out = Command::new(ffprobe)
        .args([
            "-v",
            "error",
            "-show_entries",
            "format_tags=creation_time",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
        ])
        .arg(file)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().next()?.trim();
    crate::time::parse_iso(line)
}

async fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = tokio::fs::File::open(path).await?;
    let mut hasher = sha2::Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

struct TempWorkDir(PathBuf);

impl Drop for TempWorkDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

async fn remove_existing_import(
    state: &AppState,
    user_id: &str,
    zip_sha: &str,
    old_rec_id: Option<&str>,
    old_encrypted_export_path: Option<&str>,
) {
    let _folder_guard = crate::local_folder::lock().await;
    if let Some(enc_path) = old_encrypted_export_path {
        let plain = state
            .config
            .field_key
            .decrypt(enc_path)
            .unwrap_or_else(|_| enc_path.to_owned());
        if !plain.is_empty() {
            let p = Path::new(&plain);
            if p.is_file() {
                let _ = tokio::fs::remove_file(p).await;
            }
        }
    }
    if let Some(rec_id) = old_rec_id {
        if let Ok(Some((storage_type, storage_path))) = sqlx::query_as::<_, (String, String)>(
            "SELECT storage_type, storage_path FROM recordings WHERE id = ? AND user_id = ?",
        )
        .bind(rec_id)
        .bind(user_id)
        .fetch_optional(&state.db)
        .await
        {
            let _ = state.storage.delete(&storage_type, &storage_path).await;
        }
        let _ = sqlx::query("DELETE FROM transcriptions WHERE recording_id = ?")
            .bind(rec_id)
            .execute(&state.db)
            .await;
        let _ = sqlx::query("DELETE FROM ai_enhancements WHERE recording_id = ?")
            .bind(rec_id)
            .execute(&state.db)
            .await;
        let _ = sqlx::query("DELETE FROM recordings WHERE id = ? AND user_id = ?")
            .bind(rec_id)
            .bind(user_id)
            .execute(&state.db)
            .await;
    }
    let _ = sqlx::query("DELETE FROM zip_imports WHERE user_id = ? AND zip_sha256 = ?")
        .bind(user_id)
        .bind(zip_sha)
        .execute(&state.db)
        .await;
}

#[allow(clippy::too_many_arguments)]
async fn process_zip(
    state: &AppState,
    user_id: &str,
    zip_path: &Path,
    export_folder: &Path,
    local_storage_folder: Option<&Path>,
    title_mode: &str,
    delete_zip: bool,
    duplicate_action: DuplicateAction,
) -> Result<ZipOutcome, String> {
    let zip_sha = sha256_file(zip_path).await.map_err(|e| e.to_string())?;
    let existing: Option<(Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT recording_id, export_path FROM zip_imports WHERE user_id = ? AND zip_sha256 = ?",
    )
    .bind(user_id)
    .bind(&zip_sha)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| e.to_string())?;

    if let Some((ref old_rec_id, ref old_export_path)) = existing {
        match duplicate_action {
            DuplicateAction::Skip => return Ok(ZipOutcome::Skipped),
            DuplicateAction::Ask => return Ok(ZipOutcome::AlreadyMerged),
            DuplicateAction::Replace => {
                remove_existing_import(
                    state,
                    user_id,
                    &zip_sha,
                    old_rec_id.as_deref(),
                    old_export_path.as_deref(),
                )
                .await;
            }
            DuplicateAction::KeepBoth => {
                // Keep existing Library recording and exported file intact; create a new copy below.
            }
        }
    }

    let work_id = ids::new_id();
    let work_dir = state
        .config
        .storage_root
        .join(".pipeline")
        .join(format!("zip-{work_id}"));
    tokio::fs::create_dir_all(&work_dir)
        .await
        .map_err(|e| e.to_string())?;
    let _cleanup = TempWorkDir(work_dir.clone());

    let zip_path_owned = zip_path.to_path_buf();
    let extract_dir = work_dir.clone();
    let mut segments =
        tokio::task::spawn_blocking(move || extract_zip(&zip_path_owned, &extract_dir))
            .await
            .map_err(|e| e.to_string())??;

    if segments.is_empty() {
        return Err("Archive contains no supported audio files".into());
    }

    // If any segment lacks both filename and Export-notes timestamps, probe container creation_time.
    for seg in &mut segments {
        if seg.meta.is_none() && seg.notes_start_ms.is_none() {
            seg.container_start_ms = probe_creation_time_ms(&state.config.ffprobe, &seg.path).await;
        }
    }

    sort_segments(&mut segments);

    // Probe every segment and check total duration.
    let mut probes = Vec::with_capacity(segments.len());
    for seg in &segments {
        let probe = media::probe(&state.config.ffprobe, &seg.path)
            .await
            .ok_or_else(|| format!("\"{}\" has no readable audio", seg.basename))?;
        probes.push(probe);
    }
    let total_ms: i64 = probes.iter().map(|p| p.duration_ms).sum();
    if total_ms > MAX_MERGE_MS {
        return Err("Merged recording would be longer than 24 hours".into());
    }

    let merged_temp = work_dir.join("merged.m4a");
    merge_segments(
        &state.config.ffmpeg,
        &segments,
        &probes,
        &work_dir,
        &merged_temp,
    )
    .await?;

    let out_probe = media::probe(&state.config.ffprobe, &merged_temp)
        .await
        .ok_or_else(|| "Merged audio is unreadable".to_owned())?;
    let file_md5 = media::file_md5(&merged_temp)
        .await
        .map_err(|e| e.to_string())?;
    let filesize = tokio::fs::metadata(&merged_temp)
        .await
        .map_err(|e| e.to_string())?
        .len() as i64;

    let start_ms = segments
        .first()
        .and_then(ExtractedSegment::recording_start_ms)
        .unwrap_or_else(now_ms);
    let offset = match segments.first().and_then(|s| s.meta.as_ref()) {
        Some(meta) => meta.offset,
        None => recordings::local_offset_at(start_ms).await,
    };
    let day_title = crate::time::local_date(start_ms, offset);
    let zip_stem = zip_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Merged_Recording");
    let orig_title = original_title(&segments, zip_stem);

    let (title, title_source) = match title_mode {
        "date" | "ai" => (day_title.clone(), "date"),
        _ => (orig_title, "original"),
    };

    let peaks = media::compute_peaks(&state.config.ffmpeg, &merged_temp, 256)
        .await
        .and_then(|p| serde_json::to_string(&p).ok());

    tokio::fs::create_dir_all(export_folder)
        .await
        .map_err(|e| format!("Could not create export folder: {e}"))?;
    let use_local_folder = state.storage.active_type() == "local"
        && local_storage_folder.is_some_and(|lf| crate::local_folder::same_dir(export_folder, lf));
    let rec_id = ids::new_id();
    let plaud_file_id = format!("zip-{rec_id}");
    let default_stored_key = format!("{user_id}/{plaud_file_id}.m4a");
    let export_tmp = export_folder.join(format!(".zip-{}.partial", ids::new_id()));
    if let Err(e) = tokio::fs::copy(&merged_temp, &export_tmp).await {
        let _ = tokio::fs::remove_file(&export_tmp).await;
        return Err(format!("Could not write exported file: {e}"));
    }
    if !use_local_folder
        && let Err(e) = state
            .storage
            .store_staged(&default_stored_key, &merged_temp, Some("audio/mp4"))
            .await
    {
        let _ = tokio::fs::remove_file(&export_tmp).await;
        return Err(e.to_string());
    }

    // 1. Finalize the exported file in the target export folder and insert the DB rows under the folder lock.
    let _folder_guard = crate::local_folder::lock().await;
    let export_stem = strip_m4a_ext(&safe_name(&title, &work_id));
    let export_dest = unique_path(export_folder, &export_stem, "m4a").await;
    if let Err(e) = tokio::fs::rename(&export_tmp, &export_dest).await {
        let _ = tokio::fs::remove_file(&export_tmp).await;
        if !use_local_folder {
            let _ = state
                .storage
                .delete(state.storage.active_type(), &default_stored_key)
                .await;
        }
        return Err(format!("Could not finalize exported file: {e}"));
    }

    let (storage_type, stored_key) = if use_local_folder {
        ("local_folder", export_dest.to_string_lossy().into_owned())
    } else {
        (state.storage.active_type(), default_stored_key)
    };

    let now = now_ms();
    let zip_filename = zip_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("archive.zip")
        .to_owned();
    let encrypted_title = state.config.field_key.encrypt(&title);
    let encrypted_export_path = state
        .config
        .field_key
        .encrypt(&export_dest.to_string_lossy());

    let mut tx = match crate::db::begin_write(&state.db).await {
        Ok(tx) => tx,
        Err(e) => {
            if !use_local_folder {
                let _ = state.storage.delete(storage_type, &stored_key).await;
            }
            let _ = tokio::fs::remove_file(&export_dest).await;
            return Err(e.to_string());
        }
    };
    let insert_rec = sqlx::query(
        "INSERT INTO recordings (id, user_id, device_sn, plaud_file_id, filename, duration, start_time, \
         end_time, filesize, file_md5, storage_type, storage_path, downloaded_at, plaud_version, is_trash, \
         waveform_peaks, created_at, updated_at, title_source, auto_export_eligible) \
         VALUES (?, ?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '1', 0, ?, ?, ?, ?, 0)",
    )
    .bind(&rec_id)
    .bind(user_id)
    .bind(&plaud_file_id)
    .bind(&encrypted_title)
    .bind(out_probe.duration_ms)
    .bind(start_ms)
    .bind(start_ms + out_probe.duration_ms)
    .bind(filesize)
    .bind(&file_md5)
    .bind(storage_type)
    .bind(&stored_key)
    .bind(now)
    .bind(peaks.as_deref())
    .bind(now)
    .bind(now)
    .bind(title_source)
    .execute(&mut *tx)
    .await;

    if let Err(e) = insert_rec {
        let _ = tx.rollback().await;
        if !use_local_folder {
            let _ = state.storage.delete(storage_type, &stored_key).await;
        }
        let _ = tokio::fs::remove_file(&export_dest).await;
        return Err(e.to_string());
    }

    let insert_imp = sqlx::query(
        "INSERT INTO zip_imports (id, user_id, zip_sha256, zip_filename, recording_id, export_path, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(user_id, zip_sha256) DO UPDATE SET \
            recording_id = excluded.recording_id, \
            export_path = excluded.export_path, \
            created_at = excluded.created_at",
    )
    .bind(ids::new_id())
    .bind(user_id)
    .bind(&zip_sha)
    .bind(&zip_filename)
    .bind(&rec_id)
    .bind(&encrypted_export_path)
    .bind(now)
    .execute(&mut *tx)
    .await;

    if let Err(e) = insert_imp {
        let _ = tx.rollback().await;
        if !use_local_folder {
            let _ = state.storage.delete(storage_type, &stored_key).await;
        }
        let _ = tokio::fs::remove_file(&export_dest).await;
        return Err(e.to_string());
    }

    if let Err(e) = tx.commit().await {
        if !use_local_folder {
            let _ = state.storage.delete(storage_type, &stored_key).await;
        }
        let _ = tokio::fs::remove_file(&export_dest).await;
        return Err(e.to_string());
    }
    drop(_folder_guard);

    // 3. Delete the source zip only after both library import and export file are committed on disk.
    if delete_zip && let Err(e) = tokio::fs::remove_file(zip_path).await {
        tracing::warn!(archive = %zip_filename, error = %e, "could not delete source zip after merge");
    }

    // 4. Queue automatic transcription (and subsequent AI title / summary) if enabled.
    if let Err(e) = crate::transcribe::queue_auto(state, user_id, &rec_id).await {
        tracing::warn!(recording = %rec_id, error = %e.message, "queueing automatic transcription for zip recording failed");
    }

    Ok(ZipOutcome::Merged)
}

fn extract_zip(zip_path: &Path, work_dir: &Path) -> Result<Vec<ExtractedSegment>, String> {
    let file = std::fs::File::open(zip_path).map_err(|e| format!("Could not open zip: {e}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("Invalid zip archive: {e}"))?;

    let mut notes_text = String::new();
    for i in 0..archive.len() {
        let Ok(mut entry) = archive.by_index(i) else {
            continue;
        };
        if entry.is_dir() {
            continue;
        }
        let Ok(raw_name) = entry.name() else {
            continue;
        };
        let name = raw_name.replace('\\', "/");
        if name.starts_with("__MACOSX/") {
            continue;
        }
        let base = name.rsplit('/').next().unwrap_or(&name);
        if base.eq_ignore_ascii_case("Export-notes.txt") {
            let _ = entry.read_to_string(&mut notes_text);
            break;
        }
    }
    let notes_map = parse_export_notes(&notes_text);

    let mut raw_entries: Vec<(usize, String, Option<i64>)> = Vec::new();
    for i in 0..archive.len() {
        let entry = archive
            .by_index(i)
            .map_err(|e| format!("Corrupt zip entry: {e}"))?;
        if entry.is_dir() {
            continue;
        }
        let Ok(raw_name) = entry.name() else {
            continue;
        };
        let name = raw_name.replace('\\', "/");
        if name.starts_with("__MACOSX/") {
            continue;
        }
        let base = name.rsplit('/').next().unwrap_or(&name);
        if base.starts_with('.') {
            continue;
        }
        let ext = Path::new(base)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !ACCEPTED_AUDIO.contains(&ext.as_str()) {
            continue;
        }
        let zip_mtime_ms = entry.last_modified().and_then(|dt| {
            if dt.year() <= 1980
                && dt.month() == 1
                && dt.day() == 1
                && dt.hour() == 0
                && dt.minute() == 0
            {
                return None;
            }
            let date_str = format!("{:04}-{:02}-{:02}", dt.year(), dt.month(), dt.day());
            let time_str = format!("{:02}-{:02}-{:02}", dt.hour(), dt.minute(), dt.second());
            date_time_to_ms(&date_str, &time_str, ::time::UtcOffset::UTC)
        });
        raw_entries.push((i, base.to_owned(), zip_mtime_ms));
    }

    let mut segments = Vec::with_capacity(raw_entries.len());
    for (idx, (entry_idx, base, zip_mtime_ms)) in raw_entries.into_iter().enumerate() {
        let mut entry = archive
            .by_index(entry_idx)
            .map_err(|e| format!("Corrupt zip entry {base}: {e}"))?;
        let ext = Path::new(&base)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("m4a");
        let dest = work_dir.join(format!("seg-{idx:04}.{ext}"));
        let mut out =
            std::fs::File::create(&dest).map_err(|e| format!("Could not extract {base}: {e}"))?;
        std::io::copy(&mut entry, &mut out)
            .map_err(|e| format!("Failed extracting {base}: {e}"))?;
        let meta = parse_segment_filename(&base);
        let notes_start_ms = notes_map.get(&base).copied();
        segments.push(ExtractedSegment {
            basename: base,
            path: dest,
            meta,
            notes_start_ms,
            container_start_ms: None,
            zip_mtime_ms,
        });
    }

    Ok(segments)
}

async fn merge_segments(
    ffmpeg: &Path,
    segments: &[ExtractedSegment],
    probes: &[media::Probe],
    work_dir: &Path,
    out_m4a: &Path,
) -> Result<(), String> {
    if segments.len() == 1
        && probes[0].codec == "aac"
        && segments[0]
            .path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("m4a"))
    {
        tokio::fs::copy(&segments[0].path, out_m4a)
            .await
            .map_err(|e| format!("Could not copy single segment: {e}"))?;
        return Ok(());
    }

    let same_aac = probes
        .iter()
        .all(|p| p.codec == "aac" && p.format == probes[0].format);
    let list_path = work_dir.join("concat.list");

    if same_aac {
        let list_text: String = segments
            .iter()
            .map(|s| {
                format!(
                    "file '{}'\n",
                    s.path.display().to_string().replace('\'', r"'\''")
                )
            })
            .collect();
        tokio::fs::write(&list_path, list_text)
            .await
            .map_err(|e| e.to_string())?;
        let mut cmd = Command::new(ffmpeg);
        cmd.args(["-v", "error", "-f", "concat", "-safe", "0", "-i"])
            .arg(&list_path)
            .args(["-vn", "-c", "copy", "-movflags", "+faststart", "-f", "ipod"])
            .arg(out_m4a);
        if media::run(&mut cmd).await {
            return Ok(());
        }
        let _ = tokio::fs::remove_file(out_m4a).await;
    }

    // Fallback when segments differ in codec, sample rate or channels: re-encode to AAC M4A.
    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-v", "error"]);
    let mut filter = String::new();
    for (i, seg) in segments.iter().enumerate() {
        cmd.arg("-i").arg(&seg.path);
        filter.push_str(&format!("[{i}:a:0]"));
    }
    filter.push_str(&format!("concat=n={}:v=0:a=1[out]", segments.len()));
    cmd.args([
        "-filter_complex",
        filter.as_str(),
        "-map",
        "[out]",
        "-c:a",
        "aac",
        "-b:a",
        "64k",
        "-movflags",
        "+faststart",
        "-f",
        "ipod",
    ])
    .arg(out_m4a);
    if !media::run(&mut cmd).await {
        return Err("ffmpeg failed to merge audio segments".into());
    }
    Ok(())
}

/// Renames exported `.m4a` files still carrying their date name once an AI title has been generated.
pub async fn rename_ai_exports(
    state: &AppState,
    user_id: &str,
    export_folder: &Path,
) -> Result<(), String> {
    let _folder_guard = crate::local_folder::lock().await;
    let rows: Vec<(String, String, i64, String, String, String, String)> = sqlx::query_as(
        "SELECT i.id, i.export_path, r.start_time, r.filename, r.id, r.storage_type, r.storage_path \
         FROM zip_imports i \
         JOIN recordings r ON r.id = i.recording_id \
         WHERE i.user_id = ? AND r.deleted_at IS NULL AND r.title_source = 'ai' AND i.export_path IS NOT NULL",
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await
    .map_err(|e| e.to_string())?;

    for (
        import_id,
        encrypted_path,
        start_ms,
        encrypted_title,
        rec_id,
        rec_storage_type,
        rec_storage_path,
    ) in rows
    {
        let Ok(stored_path) = state.config.field_key.decrypt(&encrypted_path) else {
            continue;
        };
        if stored_path.is_empty() {
            continue;
        }
        let path = PathBuf::from(&stored_path);
        if !path.exists() {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()).map(str::to_owned) else {
            continue;
        };
        let offset = recordings::local_offset_at(start_ms).await;
        let day = crate::time::local_date(start_ms, offset);
        // Only rename if the file on disk is still under a date name (`YYYY-MM-DD` or `YYYY-MM-DD (2)`).
        if !is_date_stem(&stem) && !is_numbered(&stem, &day) {
            continue;
        }
        let Ok(ai_title) = state.config.field_key.decrypt(&encrypted_title) else {
            continue;
        };
        let desired = strip_m4a_ext(&safe_name(&ai_title, &rec_id));
        if desired.eq_ignore_ascii_case(&stem) {
            continue;
        }
        let parent = path.parent().unwrap_or(export_folder);
        let dest = unique_path(parent, &desired, "m4a").await;
        let old_norm = crate::local_folder::normalize_path(&path);
        let rec_norm = crate::local_folder::normalize_path(Path::new(&rec_storage_path));
        if tokio::fs::rename(&path, &dest).await.is_err() {
            continue;
        }
        let dest_str = dest.to_string_lossy().into_owned();
        sqlx::query("UPDATE zip_imports SET export_path = ? WHERE id = ?")
            .bind(state.config.field_key.encrypt(&dest_str))
            .bind(&import_id)
            .execute(&state.db)
            .await
            .map_err(|e| e.to_string())?;
        if rec_storage_type == "local_folder"
            && (rec_storage_path == stored_path || rec_norm == old_norm)
        {
            sqlx::query(
                "UPDATE recordings SET storage_path = ?, updated_at = ? WHERE id = ? AND user_id = ?",
            )
            .bind(&dest_str)
            .bind(now_ms())
            .bind(&rec_id)
            .bind(user_id)
            .execute(&state.db)
            .await
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn is_date_stem(stem: &str) -> bool {
    let base = match stem.split_once(" (") {
        Some((b, rest))
            if rest
                .strip_suffix(')')
                .is_some_and(|n| !n.is_empty() && n.bytes().all(|c| c.is_ascii_digit())) =>
        {
            b
        }
        _ => stem,
    };
    is_date_token(base)
}

fn is_numbered(stem: &str, base: &str) -> bool {
    if stem == base {
        return true;
    }
    let Some(rest) = stem.strip_prefix(base) else {
        return false;
    };
    rest.strip_prefix(" (")
        .and_then(|r| r.strip_suffix(')'))
        .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

fn strip_m4a_ext(stem: &str) -> String {
    if stem.to_ascii_lowercase().ends_with(".m4a") {
        stem[..stem.len() - 4].to_owned()
    } else {
        stem.to_owned()
    }
}

fn safe_name(title: &str, fallback: &str) -> String {
    let cleaned = sanitized_title(title).or_else(|| sanitized_title(fallback));
    escape_windows_reserved(&cleaned.unwrap_or_else(|| "recording".to_owned()))
}

fn sanitized_title(value: &str) -> Option<String> {
    let mut out = String::new();
    let mut space = false;
    for c in value.chars() {
        let code = c as u32;
        if code < 32 || code == 127 {
            continue;
        }
        if c.is_whitespace() {
            if !space {
                space = true;
                out.push(' ');
            }
            continue;
        }
        space = false;
        out.push(if "/\\:*?\"<>|".contains(c) { '-' } else { c });
    }
    let trimmed = out.trim();
    if trimmed.is_empty() {
        return None;
    }
    let capped: String = trimmed.chars().take(200).collect();
    let capped = capped.trim().to_owned();
    (!capped.is_empty()).then_some(capped)
}

fn escape_windows_reserved(name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    let (base, rest) = match lower.split_once('.') {
        Some((base, rest)) => (base, Some(rest)),
        None => (lower.as_str(), None),
    };
    let fixed = matches!(base, "con" | "prn" | "aux" | "nul");
    let numbered = base.len() == 4
        && (base.starts_with("com") || base.starts_with("lpt"))
        && matches!(base.as_bytes()[3], b'1'..=b'9');
    let one_extension = rest.is_none_or(|r| !r.is_empty() && !r.contains('.'));
    if (fixed || numbered) && one_extension {
        format!("_{name}")
    } else {
        name.to_owned()
    }
}

async fn unique_path(folder: &Path, stem: &str, ext: &str) -> PathBuf {
    let mut n = 1;
    loop {
        let name = if n == 1 {
            format!("{stem}.{ext}")
        } else {
            format!("{stem} ({n}).{ext}")
        };
        let path = folder.join(name);
        if !tokio::fs::try_exists(&path).await.unwrap_or(false) {
            return path;
        }
        n += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn parses_same_day_and_cross_midnight_segment_filenames() {
        let same =
            parse_segment_filename("Rec_2026-10-29_00-00-00_to_01-00-00_UTC-0700.m4a").unwrap();
        assert_eq!(same.start_date, "2026-10-29");
        assert_eq!(same.start_time, "00-00-00");
        assert_eq!(same.end_date, "2026-10-29");
        assert_eq!(same.end_time, "01-00-00");
        assert_eq!(same.offset, ::time::UtcOffset::from_hms(-7, 0, 0).unwrap());
        // 2026-10-29T00:00:00-07:00 == 2026-10-29T07:00:00Z
        assert_eq!(
            same.start_ms,
            crate::time::parse_iso("2026-10-29T07:00:00Z").unwrap()
        );

        let cross = parse_segment_filename(
            "Segment_2026-10-30_23-00-00_to_2026-10-31_00-00-00_UTC-0700.m4a",
        )
        .unwrap();
        assert_eq!(cross.start_date, "2026-10-30");
        assert_eq!(cross.start_time, "23-00-00");
        assert_eq!(cross.end_date, "2026-10-31");
        assert_eq!(cross.end_time, "00-00-00");
        assert_eq!(
            cross.start_ms,
            crate::time::parse_iso("2026-10-31T06:00:00Z").unwrap()
        );
    }

    #[test]
    fn parses_export_notes_in_both_section_and_inline_formats() {
        let notes = "\
[Export 2026-10-31T21:11:37Z]
files: 2

[Rec_2026-10-29_00-00-00_to_01-00-00_UTC-0700.m4a]
  file +0.000s | 2026-10-29T07:18:52Z – 2026-10-29T07:19:46Z
  file +53.800s | 2026-10-29T07:26:49Z – 2026-10-29T07:27:55Z

Rec_2026-10-29_12-00-00_to_13-00-00_UTC-0700.m4a | file +0.000s | 2026-10-29T19:04:37Z – 2026-10-29T19:19:38Z
";
        let parsed = parse_export_notes(notes);
        assert_eq!(
            parsed.get("Rec_2026-10-29_00-00-00_to_01-00-00_UTC-0700.m4a"),
            crate::time::parse_iso("2026-10-29T07:18:52Z").as_ref()
        );
        assert_eq!(
            parsed.get("Rec_2026-10-29_12-00-00_to_13-00-00_UTC-0700.m4a"),
            crate::time::parse_iso("2026-10-29T19:04:37Z").as_ref()
        );
    }

    #[test]
    fn sorts_out_of_order_segments_by_timeline_and_computes_original_title() {
        let names = [
            "Rec_2026-10-29_20-00-00_to_21-00-00_UTC-0700.m4a",
            "Rec_2026-10-29_00-00-00_to_01-00-00_UTC-0700.m4a",
            "Rec_2026-10-29_12-00-00_to_13-00-00_UTC-0700.m4a",
        ];
        let mut segs: Vec<ExtractedSegment> = names
            .iter()
            .map(|n| ExtractedSegment {
                basename: (*n).to_owned(),
                path: PathBuf::from(n),
                meta: parse_segment_filename(n),
                notes_start_ms: None,
                container_start_ms: None,
                zip_mtime_ms: None,
            })
            .collect();
        sort_segments(&mut segs);
        assert_eq!(
            segs[0].basename,
            "Rec_2026-10-29_00-00-00_to_01-00-00_UTC-0700.m4a"
        );
        assert_eq!(
            segs[1].basename,
            "Rec_2026-10-29_12-00-00_to_13-00-00_UTC-0700.m4a"
        );
        assert_eq!(
            segs[2].basename,
            "Rec_2026-10-29_20-00-00_to_21-00-00_UTC-0700.m4a"
        );
        assert_eq!(
            original_title(&segs, "Batch_Export"),
            "2026-10-29_00-00-00_to_21-00-00"
        );
    }

    async fn desktop_state(settings: Value) -> (AppState, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let mut config = crate::Config::for_tests(dir.path());
        config.desktop = Some(crate::config::Desktop {
            launch_secret: "0123456789abcdef0123456789abcdef-launch".into(),
            user_id: None,
        });
        let state = AppState::new(config, crate::db::open_memory().await.unwrap());
        sqlx::query(
            "INSERT INTO users (id, email, created_at, updated_at) VALUES ('u', 'u@example.test', 0, 0)",
        )
        .execute(&state.db)
        .await
        .unwrap();
        sqlx::query("INSERT INTO user_settings (user_id, data, updated_at) VALUES ('u', ?, 0)")
            .bind(settings.to_string())
            .execute(&state.db)
            .await
            .unwrap();
        (state, dir)
    }

    async fn make_m4a_tone(ffmpeg: &Path, dst: &Path, freq: u32) {
        let mut cmd = Command::new(ffmpeg);
        cmd.args([
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            &format!("sine=frequency={freq}:sample_rate=48000:duration=1"),
            "-c:a",
            "aac",
            "-b:a",
            "64k",
            "-f",
            "ipod",
        ])
        .arg(dst);
        assert!(media::run(&mut cmd).await, "ffmpeg creates test m4a");
    }

    fn write_test_zip(zip_path: &Path, entries: &[(&str, &[u8])]) {
        let file = std::fs::File::create(zip_path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        for (name, data) in entries {
            zip.start_file(*name, opts).unwrap();
            zip.write_all(data).unwrap();
        }
        let f = zip.finish().unwrap();
        f.sync_all().unwrap();
        f.set_modified(filetime_minus_5s()).unwrap();
    }

    #[tokio::test]
    async fn unpacks_merges_in_timeline_order_handles_duplicates_and_respects_delete_zip() {
        let watch_dir = tempfile::tempdir().unwrap();
        let export_dir = tempfile::tempdir().unwrap();
        let (state, work) = desktop_state(json!({
            "zipAutoMerge": true,
            "zipWatchFolder": watch_dir.path().to_string_lossy(),
            "zipExportFolder": export_dir.path().to_string_lossy(),
            "zipTitleMode": "original",
            "zipDeleteAfterMerge": false,
        }))
        .await;

        let seg1 = work.path().join("s1.m4a");
        let seg2 = work.path().join("s2.m4a");
        make_m4a_tone(&state.config.ffmpeg, &seg1, 440).await;
        make_m4a_tone(&state.config.ffmpeg, &seg2, 880).await;
        let b1 = std::fs::read(&seg1).unwrap();
        let b2 = std::fs::read(&seg2).unwrap();
        let notes = b"[Rec_2026-10-29_12-00-00_to_13-00-00_UTC-0700.m4a]\n  file +0.000s | 2026-10-29T19:04:37Z - 2026-10-29T19:19:38Z\n\
                      [Rec_2026-10-29_13-00-00_to_14-00-00_UTC-0700.m4a]\n  file +0.000s | 2026-10-29T20:00:00Z - 2026-10-29T20:15:00Z\n";

        // Put the later segment first in the zip to verify chronological sorting.
        let zip_path = watch_dir.path().join("Batch_Export.zip");
        write_test_zip(
            &zip_path,
            &[
                ("Rec_2026-10-29_13-00-00_to_14-00-00_UTC-0700.m4a", &b2),
                ("Rec_2026-10-29_12-00-00_to_13-00-00_UTC-0700.m4a", &b1),
                ("Export-notes.txt", notes),
            ],
        );

        let settings = effective(&state, "u").await.unwrap();
        let r1 = scan_user(&state, "u", watch_dir.path(), &settings)
            .await
            .unwrap();
        assert_eq!(r1.merged, 1);
        assert_eq!(r1.skipped, 0);
        assert!(r1.errors.is_empty());
        assert!(
            zip_path.exists(),
            "zip is kept when zipDeleteAfterMerge is false"
        );

        let exported = export_dir
            .path()
            .join("2026-10-29_12-00-00_to_14-00-00.m4a");
        assert!(exported.exists(), "merged m4a is written to export folder");
        let probe = media::probe(&state.config.ffprobe, &exported)
            .await
            .unwrap();
        assert!(
            probe.duration_ms >= 1800,
            "merged duration covers both 1s segments: {}",
            probe.duration_ms
        );

        // Manual scan with DuplicateAction::Ask reports the archive in already_merged.
        let r_ask = scan_user_with_options(
            &state,
            "u",
            watch_dir.path(),
            &settings,
            true,
            DuplicateAction::Ask,
            None,
        )
        .await
        .unwrap();
        assert_eq!(r_ask.merged, 0);
        assert_eq!(r_ask.already_merged, vec!["Batch_Export.zip"]);

        // Manual scan with DuplicateAction::KeepBoth keeps the original and creates a (2) copy.
        let r_keep = scan_user_with_options(
            &state,
            "u",
            watch_dir.path(),
            &settings,
            true,
            DuplicateAction::KeepBoth,
            Some(&["Batch_Export.zip".to_owned()]),
        )
        .await
        .unwrap();
        assert_eq!(r_keep.merged, 1);
        let exported_2 = export_dir
            .path()
            .join("2026-10-29_12-00-00_to_14-00-00 (2).m4a");
        assert!(exported.exists());
        assert!(exported_2.exists());

        // Manual scan with DuplicateAction::Replace replaces the latest imported copy.
        let r_replace = scan_user_with_options(
            &state,
            "u",
            watch_dir.path(),
            &settings,
            true,
            DuplicateAction::Replace,
            Some(&["Batch_Export.zip".to_owned()]),
        )
        .await
        .unwrap();
        assert_eq!(r_replace.merged, 1);
        assert!(exported_2.exists());

        // Now test date + ai rename + delete_zip on a second archive.
        sqlx::query("UPDATE user_settings SET data = ? WHERE user_id = 'u'")
            .bind(
                json!({
                    "zipAutoMerge": true,
                    "zipWatchFolder": watch_dir.path().to_string_lossy(),
                    "zipExportFolder": export_dir.path().to_string_lossy(),
                    "zipTitleMode": "ai",
                    "zipDeleteAfterMerge": true,
                })
                .to_string(),
            )
            .execute(&state.db)
            .await
            .unwrap();

        let zip2_path = watch_dir.path().join("Batch_Export 2.zip");
        write_test_zip(
            &zip2_path,
            &[("Rec_2026-10-30_14-00-00_to_15-00-00_UTC-0700.m4a", &b1)],
        );

        let settings2 = effective(&state, "u").await.unwrap();
        let r3 = scan_user(&state, "u", watch_dir.path(), &settings2)
            .await
            .unwrap();
        assert_eq!(r3.merged, 1);
        assert!(
            !zip2_path.exists(),
            "zip is deleted when zipDeleteAfterMerge is true"
        );
        let date_exported = export_dir.path().join("2026-10-30.m4a");
        assert!(date_exported.exists(), "ai mode starts with date filename");

        // Simulate AI title completion on that recording.
        let rec_id: String = sqlx::query_scalar(
            "SELECT recording_id FROM zip_imports WHERE zip_filename = 'Batch_Export 2.zip'",
        )
        .fetch_one(&state.db)
        .await
        .unwrap();
        sqlx::query("UPDATE recordings SET filename = ?, title_source = 'ai' WHERE id = ?")
            .bind(state.config.field_key.encrypt("Morning Watch Notes"))
            .bind(&rec_id)
            .execute(&state.db)
            .await
            .unwrap();

        rename_ai_exports(&state, "u", export_dir.path())
            .await
            .unwrap();
        assert!(!date_exported.exists());
        assert!(export_dir.path().join("Morning Watch Notes.m4a").exists());
    }

    fn filetime_minus_5s() -> SystemTime {
        SystemTime::now() - Duration::from_secs(5)
    }
}
