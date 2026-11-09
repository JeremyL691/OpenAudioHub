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

    // Probe every segment, repairing unfinalized MP4/M4A containers or skipping unreadable entries when other valid segments exist.
    let mut raw_probes: Vec<Option<media::Probe>> = Vec::with_capacity(segments.len());
    for seg in &segments {
        raw_probes.push(media::probe(&state.config.ffprobe, &seg.path).await);
    }

    let donor = if raw_probes.iter().any(Option::is_none) {
        segments
            .iter()
            .zip(raw_probes.iter())
            .filter_map(|(seg, probe)| probe.as_ref().and(Some(&seg.path)))
            .find_map(|path| extract_mp4_audio_donor(path))
    } else {
        None
    };

    let mut valid_segments = Vec::with_capacity(segments.len());
    let mut probes = Vec::with_capacity(segments.len());
    let mut first_unreadable_basename: Option<String> = None;

    for (idx, (mut seg, maybe_probe)) in segments.into_iter().zip(raw_probes).enumerate() {
        if let Some(probe) = maybe_probe {
            valid_segments.push(seg);
            probes.push(probe);
        } else if let Some((repaired_path, probe)) = repair_unfinalized_mp4(
            &state.config.ffmpeg,
            &state.config.ffprobe,
            &seg.path,
            donor.as_ref(),
            &work_dir,
            idx,
        )
        .await
        {
            tracing::info!(
                segment = %seg.basename,
                duration_ms = probe.duration_ms,
                "repaired unfinalized mp4/m4a audio segment in zip archive"
            );
            seg.path = repaired_path;
            valid_segments.push(seg);
            probes.push(probe);
        } else {
            tracing::warn!(
                segment = %seg.basename,
                "skipping unreadable audio segment in zip archive"
            );
            first_unreadable_basename.get_or_insert_with(|| seg.basename.clone());
        }
    }

    if valid_segments.is_empty() {
        let bad = first_unreadable_basename.unwrap_or_else(|| "segment".to_owned());
        return Err(format!("\"{bad}\" has no readable audio"));
    }
    let segments = valid_segments;

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
    let mut first_extract_err: Option<String> = None;
    for i in 0..archive.len() {
        let entry = match archive.by_index(i) {
            Ok(e) => e,
            Err(e) => {
                let msg = format!("Corrupt zip entry: {e}");
                tracing::warn!(index = i, error = %e, "skipping corrupt zip entry");
                first_extract_err.get_or_insert(msg);
                continue;
            }
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
        let mut entry = match archive.by_index(entry_idx) {
            Ok(e) => e,
            Err(e) => {
                let msg = format!("Corrupt zip entry {base}: {e}");
                tracing::warn!(segment = %base, error = %e, "skipping corrupt zip entry");
                first_extract_err.get_or_insert(msg);
                continue;
            }
        };
        let ext = Path::new(&base)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("m4a");
        let dest = work_dir.join(format!("seg-{idx:04}.{ext}"));
        let copy_res = std::fs::File::create(&dest)
            .map_err(|e| format!("Could not extract {base}: {e}"))
            .and_then(|mut out| {
                std::io::copy(&mut entry, &mut out)
                    .map_err(|e| format!("Failed extracting {base}: {e}"))
            });
        if let Err(err) = copy_res {
            let _ = std::fs::remove_file(&dest);
            tracing::warn!(segment = %base, error = %err, "skipping failed zip entry extraction");
            first_extract_err.get_or_insert(err);
            continue;
        }
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

    if segments.is_empty()
        && let Some(err) = first_extract_err
    {
        return Err(err);
    }

    Ok(segments)
}

#[derive(Clone)]
struct DonorAudioConfig {
    stsd_payload: Vec<u8>,
    sample_rate: u32,
    channels: u16,
}

fn scan_mp4_boxes(
    data: &[u8],
    depth: u8,
    mdhd_timescale: &mut Option<u32>,
    stsd_info: &mut Option<(Vec<u8>, u16, u32)>,
) {
    if depth > 8 || stsd_info.is_some() {
        return;
    }
    let mut pos = 0usize;
    while pos + 8 <= data.len() && stsd_info.is_none() {
        let size32 = u32::from_be_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]]);
        let btype = &data[pos + 4..pos + 8];
        let (hdr_len, box_size) = if size32 == 1 {
            if pos + 16 > data.len() {
                break;
            }
            let s64 = u64::from_be_bytes([
                data[pos + 8],
                data[pos + 9],
                data[pos + 10],
                data[pos + 11],
                data[pos + 12],
                data[pos + 13],
                data[pos + 14],
                data[pos + 15],
            ]);
            (16usize, usize::try_from(s64).unwrap_or(0))
        } else if size32 == 0 {
            (8usize, data.len() - pos)
        } else {
            (8usize, size32 as usize)
        };
        if box_size < hdr_len || pos.saturating_add(box_size) > data.len() {
            break;
        }
        let payload = &data[pos + hdr_len..pos + box_size];
        match btype {
            b"trak" => {
                let mut trak_ts = None;
                let mut trak_stsd = None;
                scan_mp4_boxes(payload, depth + 1, &mut trak_ts, &mut trak_stsd);
                if trak_stsd.is_some() {
                    *mdhd_timescale = trak_ts;
                    *stsd_info = trak_stsd;
                    return;
                }
            }
            b"moov" | b"mdia" | b"minf" | b"stbl" => {
                scan_mp4_boxes(payload, depth + 1, mdhd_timescale, stsd_info);
            }
            b"mdhd" => {
                if payload.len() >= 16 && payload[0] == 0 {
                    let ts =
                        u32::from_be_bytes([payload[12], payload[13], payload[14], payload[15]]);
                    if ts > 0 {
                        *mdhd_timescale = Some(ts);
                    }
                } else if payload.len() >= 24 && payload[0] == 1 {
                    let ts =
                        u32::from_be_bytes([payload[20], payload[21], payload[22], payload[23]]);
                    if ts > 0 {
                        *mdhd_timescale = Some(ts);
                    }
                }
            }
            b"stsd" if payload.len() >= 44 && &payload[12..16] == b"mp4a" => {
                let channels = u16::from_be_bytes([payload[32], payload[33]]);
                let sr_fixed =
                    u32::from_be_bytes([payload[40], payload[41], payload[42], payload[43]]);
                let sr = sr_fixed >> 16;
                *stsd_info = Some((payload.to_vec(), channels, sr));
            }
            _ => {}
        }
        pos += box_size;
    }
}

fn extract_mp4_audio_donor(path: &Path) -> Option<DonorAudioConfig> {
    use std::io::{Seek, SeekFrom};

    let mut file = std::fs::File::open(path).ok()?;
    let file_len = file.metadata().ok()?.len();
    let mut pos = 0u64;
    let mut hdr = [0u8; 8];
    let mut hdr64 = [0u8; 8];

    while pos.checked_add(8)? <= file_len {
        file.seek(SeekFrom::Start(pos)).ok()?;
        file.read_exact(&mut hdr).ok()?;
        let size32 = u32::from_be_bytes([hdr[0], hdr[1], hdr[2], hdr[3]]);
        let btype = &hdr[4..8];
        let (hdr_len, box_size) = if size32 == 1 {
            if pos.checked_add(16)? > file_len {
                break;
            }
            file.read_exact(&mut hdr64).ok()?;
            (16u64, u64::from_be_bytes(hdr64))
        } else if size32 == 0 {
            (8u64, file_len - pos)
        } else {
            (8u64, u64::from(size32))
        };
        if box_size < hdr_len || pos.checked_add(box_size)? > file_len {
            break;
        }
        if btype == b"moov" {
            let payload_len = usize::try_from(box_size - hdr_len).ok()?;
            if payload_len == 0 || payload_len > 32 * 1024 * 1024 {
                return None;
            }
            let mut moov_payload = vec![0u8; payload_len];
            file.read_exact(&mut moov_payload).ok()?;
            let mut mdhd_timescale = None;
            let mut stsd_info = None;
            scan_mp4_boxes(&moov_payload, 0, &mut mdhd_timescale, &mut stsd_info);
            let (stsd_payload, channels, stsd_sr) = stsd_info?;
            let sample_rate = mdhd_timescale.filter(|&sr| sr > 0).unwrap_or(stsd_sr);
            if sample_rate > 0 && channels > 0 {
                return Some(DonorAudioConfig {
                    stsd_payload,
                    sample_rate,
                    channels,
                });
            }
            return None;
        }
        pos = pos.checked_add(box_size)?;
    }
    None
}

fn mp4_box(btype: &[u8; 4], payload: &[u8]) -> Vec<u8> {
    let size = (8 + payload.len()) as u32;
    let mut out = Vec::with_capacity(size as usize);
    out.extend_from_slice(&size.to_be_bytes());
    out.extend_from_slice(btype);
    out.extend_from_slice(payload);
    out
}

fn mp4_fullbox(btype: &[u8; 4], version: u8, flags: u32, body: &[u8]) -> Vec<u8> {
    let size = (12 + body.len()) as u32;
    let mut out = Vec::with_capacity(size as usize);
    out.extend_from_slice(&size.to_be_bytes());
    out.extend_from_slice(btype);
    let vf = (u32::from(version) << 24) | (flags & 0x00FF_FFFF);
    out.extend_from_slice(&vf.to_be_bytes());
    out.extend_from_slice(body);
    out
}

fn synthesize_aac_stsd_payload(sample_rate: u32, channels: u16) -> Vec<u8> {
    let freq_idx: u8 = match sample_rate {
        96000 => 0,
        88200 => 1,
        64000 => 2,
        48000 => 3,
        44100 => 4,
        32000 => 5,
        24000 => 6,
        22050 => 7,
        16000 => 8,
        12000 => 9,
        11025 => 10,
        8000 => 11,
        7350 => 12,
        _ => 8,
    };
    let asc: u16 = (2 << 11) | (u16::from(freq_idx) << 7) | ((channels & 0xF) << 3);
    let asc_bytes = asc.to_be_bytes();
    let esds_body = [
        0x03,
        0x19,
        0x00,
        0x01,
        0x00,
        0x04,
        0x11,
        0x40,
        0x15,
        0x00,
        0x00,
        0x00,
        0x00,
        0x01,
        0xF4,
        0x00,
        0x00,
        0x00,
        0xFA,
        0x00,
        0x05,
        0x02,
        asc_bytes[0],
        asc_bytes[1],
        0x06,
        0x01,
        0x02,
    ];
    let esds = mp4_fullbox(b"esds", 0, 0, &esds_body);

    let mut mp4a_body = Vec::with_capacity(28 + esds.len());
    mp4a_body.extend_from_slice(&[0u8; 6]);
    mp4a_body.extend_from_slice(&1u16.to_be_bytes());
    mp4a_body.extend_from_slice(&[0u8; 8]);
    mp4a_body.extend_from_slice(&channels.to_be_bytes());
    mp4a_body.extend_from_slice(&16u16.to_be_bytes());
    mp4a_body.extend_from_slice(&[0u8; 4]);
    mp4a_body.extend_from_slice(&(sample_rate.min(65535) << 16).to_be_bytes());
    mp4a_body.extend_from_slice(&esds);
    let mp4a = mp4_box(b"mp4a", &mp4a_body);

    let mut stsd_payload = Vec::with_capacity(8 + mp4a.len());
    stsd_payload.extend_from_slice(&0u32.to_be_bytes());
    stsd_payload.extend_from_slice(&1u32.to_be_bytes());
    stsd_payload.extend_from_slice(&mp4a);
    stsd_payload
}

fn build_minimal_moov(
    stsd_payload: &[u8],
    mdat_data_offset: u64,
    mdat_data_len: u32,
    sample_rate: u32,
) -> Vec<u8> {
    let stsd = mp4_box(b"stsd", stsd_payload);

    let mut stts_body = Vec::with_capacity(12);
    stts_body.extend_from_slice(&1u32.to_be_bytes());
    stts_body.extend_from_slice(&1u32.to_be_bytes());
    stts_body.extend_from_slice(&1024u32.to_be_bytes());
    let stts = mp4_fullbox(b"stts", 0, 0, &stts_body);

    let mut stsc_body = Vec::with_capacity(16);
    stsc_body.extend_from_slice(&1u32.to_be_bytes());
    stsc_body.extend_from_slice(&1u32.to_be_bytes());
    stsc_body.extend_from_slice(&1u32.to_be_bytes());
    stsc_body.extend_from_slice(&1u32.to_be_bytes());
    let stsc = mp4_fullbox(b"stsc", 0, 0, &stsc_body);

    let mut stsz_body = Vec::with_capacity(8);
    stsz_body.extend_from_slice(&mdat_data_len.to_be_bytes());
    stsz_body.extend_from_slice(&1u32.to_be_bytes());
    let stsz = mp4_fullbox(b"stsz", 0, 0, &stsz_body);

    let mut co64_body = Vec::with_capacity(12);
    co64_body.extend_from_slice(&1u32.to_be_bytes());
    co64_body.extend_from_slice(&mdat_data_offset.to_be_bytes());
    let co64 = mp4_fullbox(b"co64", 0, 0, &co64_body);

    let stbl = mp4_box(b"stbl", &[stsd, stts, stsc, stsz, co64].concat());
    let smhd = mp4_fullbox(b"smhd", 0, 0, &[0u8; 4]);
    let url = mp4_fullbox(b"url ", 0, 1, &[]);
    let mut dref_body = Vec::with_capacity(4 + url.len());
    dref_body.extend_from_slice(&1u32.to_be_bytes());
    dref_body.extend_from_slice(&url);
    let dref = mp4_fullbox(b"dref", 0, 0, &dref_body);
    let dinf = mp4_box(b"dinf", &dref);
    let minf = mp4_box(b"minf", &[smhd, dinf, stbl].concat());

    let mut mdhd_body = Vec::with_capacity(20);
    mdhd_body.extend_from_slice(&0u32.to_be_bytes());
    mdhd_body.extend_from_slice(&0u32.to_be_bytes());
    mdhd_body.extend_from_slice(&sample_rate.to_be_bytes());
    mdhd_body.extend_from_slice(&1024u32.to_be_bytes());
    mdhd_body.extend_from_slice(&0x55c4u16.to_be_bytes());
    mdhd_body.extend_from_slice(&0u16.to_be_bytes());
    let mdhd = mp4_fullbox(b"mdhd", 0, 0, &mdhd_body);

    let mut hdlr_body = Vec::with_capacity(20 + 12);
    hdlr_body.extend_from_slice(&0u32.to_be_bytes());
    hdlr_body.extend_from_slice(b"soun");
    hdlr_body.extend_from_slice(&[0u8; 12]);
    hdlr_body.extend_from_slice(b"SoundHandle\0");
    let hdlr = mp4_fullbox(b"hdlr", 0, 0, &hdlr_body);
    let mdia = mp4_box(b"mdia", &[mdhd, hdlr, minf].concat());

    let unity_matrix: [u32; 9] = [0x0001_0000, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000];
    let mut matrix_bytes = [0u8; 36];
    for (i, v) in unity_matrix.iter().enumerate() {
        matrix_bytes[i * 4..(i + 1) * 4].copy_from_slice(&v.to_be_bytes());
    }

    let mut tkhd_body = Vec::with_capacity(80);
    tkhd_body.extend_from_slice(&0u32.to_be_bytes());
    tkhd_body.extend_from_slice(&0u32.to_be_bytes());
    tkhd_body.extend_from_slice(&1u32.to_be_bytes());
    tkhd_body.extend_from_slice(&0u32.to_be_bytes());
    tkhd_body.extend_from_slice(&1024u32.to_be_bytes());
    tkhd_body.extend_from_slice(&[0u8; 8]);
    tkhd_body.extend_from_slice(&0u16.to_be_bytes());
    tkhd_body.extend_from_slice(&0u16.to_be_bytes());
    tkhd_body.extend_from_slice(&0x0100u16.to_be_bytes());
    tkhd_body.extend_from_slice(&0u16.to_be_bytes());
    tkhd_body.extend_from_slice(&matrix_bytes);
    tkhd_body.extend_from_slice(&0u32.to_be_bytes());
    tkhd_body.extend_from_slice(&0u32.to_be_bytes());
    let tkhd = mp4_fullbox(b"tkhd", 0, 3, &tkhd_body);
    let trak = mp4_box(b"trak", &[tkhd, mdia].concat());

    let mut mvhd_body = Vec::with_capacity(96);
    mvhd_body.extend_from_slice(&0u32.to_be_bytes());
    mvhd_body.extend_from_slice(&0u32.to_be_bytes());
    mvhd_body.extend_from_slice(&sample_rate.to_be_bytes());
    mvhd_body.extend_from_slice(&1024u32.to_be_bytes());
    mvhd_body.extend_from_slice(&0x0001_0000u32.to_be_bytes());
    mvhd_body.extend_from_slice(&0x0100u16.to_be_bytes());
    mvhd_body.extend_from_slice(&0u16.to_be_bytes());
    mvhd_body.extend_from_slice(&[0u8; 8]);
    mvhd_body.extend_from_slice(&matrix_bytes);
    mvhd_body.extend_from_slice(&[0u8; 24]);
    mvhd_body.extend_from_slice(&2u32.to_be_bytes());
    let mvhd = mp4_fullbox(b"mvhd", 0, 0, &mvhd_body);

    mp4_box(b"moov", &[mvhd, trak].concat())
}

fn find_unfinalized_mdat(data: &[u8]) -> Option<(usize, usize, usize)> {
    if data.len() < 8 || &data[4..8] != b"ftyp" {
        return None;
    }
    let mut pos = 0usize;
    while pos + 8 <= data.len() {
        let size32 = u32::from_be_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]]);
        let btype = &data[pos + 4..pos + 8];
        let (hdr_len, box_size) = if size32 == 1 {
            if pos + 16 > data.len() {
                return None;
            }
            let s64 = u64::from_be_bytes([
                data[pos + 8],
                data[pos + 9],
                data[pos + 10],
                data[pos + 11],
                data[pos + 12],
                data[pos + 13],
                data[pos + 14],
                data[pos + 15],
            ]);
            (16usize, s64)
        } else if size32 == 0 {
            (8usize, (data.len() - pos) as u64)
        } else {
            (8usize, u64::from(size32))
        };

        if btype == b"mdat" {
            let data_start = pos.checked_add(hdr_len)?;
            if data_start >= data.len() {
                return None;
            }
            let data_end = if box_size < hdr_len as u64 {
                data.len()
            } else {
                (pos as u64).saturating_add(box_size).min(data.len() as u64) as usize
            };
            let data_len = data_end.checked_sub(data_start)?;
            if data_len == 0 {
                return None;
            }
            return Some((pos, hdr_len, data_len));
        }

        if box_size < hdr_len as u64 {
            return None;
        }
        let step = usize::try_from(box_size).ok()?;
        pos = pos.checked_add(step)?;
    }
    None
}

async fn repair_unfinalized_mp4(
    ffmpeg: &Path,
    ffprobe: &Path,
    seg_path: &Path,
    donor: Option<&DonorAudioConfig>,
    work_dir: &Path,
    idx: usize,
) -> Option<(PathBuf, media::Probe)> {
    let mut raw = tokio::fs::read(seg_path).await.ok()?;
    let (mdat_offset, mdat_hdr_len, mdat_data_len) = find_unfinalized_mdat(&raw)?;
    let mdat_data_len_u32 = u32::try_from(mdat_data_len).ok()?;
    let mdat_data_start = mdat_offset + mdat_hdr_len;
    let mdat_data_end = mdat_data_start + mdat_data_len;

    let mut candidates: Vec<DonorAudioConfig> = Vec::new();
    if let Some(d) = donor {
        candidates.push(d.clone());
    }
    let first_byte = raw[mdat_data_start];
    let guessed_channels = if (first_byte >> 5) == 1 { 2u16 } else { 1u16 };
    for sr in [16000u32, 48000, 44100, 32000, 24000, 8000] {
        if !candidates
            .iter()
            .any(|c| c.sample_rate == sr && c.channels == guessed_channels)
        {
            candidates.push(DonorAudioConfig {
                stsd_payload: synthesize_aac_stsd_payload(sr, guessed_channels),
                sample_rate: sr,
                channels: guessed_channels,
            });
        }
    }

    raw.truncate(mdat_data_end);
    if mdat_hdr_len == 16 {
        let new_mdat_size = (16 + mdat_data_len) as u64;
        raw[mdat_offset + 8..mdat_offset + 16].copy_from_slice(&new_mdat_size.to_be_bytes());
    } else {
        let new_mdat_size = u32::try_from(8 + mdat_data_len).ok()?;
        raw[mdat_offset..mdat_offset + 4].copy_from_slice(&new_mdat_size.to_be_bytes());
    }

    for cfg in &candidates {
        raw.truncate(mdat_data_end);
        let moov = build_minimal_moov(
            &cfg.stsd_payload,
            mdat_data_start as u64,
            mdat_data_len_u32,
            cfg.sample_rate,
        );
        raw.extend_from_slice(&moov);

        let patched_path = work_dir.join(format!("patched-{idx:04}.m4a"));
        let repaired_path = work_dir.join(format!("repaired-{idx:04}.m4a"));
        if tokio::fs::write(&patched_path, &raw).await.is_err() {
            let _ = tokio::fs::remove_file(&patched_path).await;
            continue;
        }

        let mut cmd = Command::new(ffmpeg);
        cmd.args(["-y", "-v", "error", "-i"])
            .arg(&patched_path)
            .args([
                "-vn",
                "-c:a",
                "aac",
                "-b:a",
                "64k",
                "-ar",
                &cfg.sample_rate.to_string(),
                "-ac",
                &cfg.channels.to_string(),
                "-movflags",
                "+faststart",
                "-f",
                "ipod",
            ])
            .arg(&repaired_path);
        let ok = media::run(&mut cmd).await;
        let _ = tokio::fs::remove_file(&patched_path).await;
        if ok
            && let Some(probe) = media::probe(ffprobe, &repaired_path).await
            && probe.duration_ms > 0
        {
            let _ = tokio::fs::remove_file(seg_path).await;
            return Some((repaired_path, probe));
        }
        let _ = tokio::fs::remove_file(&repaired_path).await;
    }

    None
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

    fn make_unfinalized_m4a(valid_m4a: &[u8]) -> Vec<u8> {
        let mut pos = 0usize;
        let mut ftyp_box: &[u8] = &[];
        let mut mdat_payload: &[u8] = &[];
        while pos + 8 <= valid_m4a.len() {
            let sz = u32::from_be_bytes([
                valid_m4a[pos],
                valid_m4a[pos + 1],
                valid_m4a[pos + 2],
                valid_m4a[pos + 3],
            ]) as usize;
            if sz < 8 || pos + sz > valid_m4a.len() {
                break;
            }
            let btype = &valid_m4a[pos + 4..pos + 8];
            if btype == b"ftyp" {
                ftyp_box = &valid_m4a[pos..pos + sz];
            } else if btype == b"mdat" {
                mdat_payload = &valid_m4a[pos + 8..pos + sz];
            }
            pos += sz;
        }
        assert!(!ftyp_box.is_empty() && !mdat_payload.is_empty());
        let mut out = Vec::with_capacity(ftyp_box.len() + 16 + mdat_payload.len());
        out.extend_from_slice(ftyp_box);
        out.extend_from_slice(&1u32.to_be_bytes());
        out.extend_from_slice(b"mdat");
        out.extend_from_slice(b"????????");
        out.extend_from_slice(mdat_payload);
        out
    }

    #[tokio::test]
    async fn repairs_unfinalized_m4a_segments_and_skips_empty_corrupt_entries() {
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

        let seg1 = work.path().join("s1_16k.m4a");
        let seg2 = work.path().join("s2_16k.m4a");
        for (dst, freq) in [(&seg1, 440u32), (&seg2, 660u32)] {
            let mut cmd = Command::new(&state.config.ffmpeg);
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

        let b1 = std::fs::read(&seg1).unwrap();
        let b2 = std::fs::read(&seg2).unwrap();
        let unfinalized_b1 = make_unfinalized_m4a(&b1);

        let raw_check = work.path().join("raw_unfinalized.m4a");
        std::fs::write(&raw_check, &unfinalized_b1).unwrap();
        assert!(
            media::probe(&state.config.ffprobe, &raw_check)
                .await
                .is_none(),
            "unfinalized m4a without moov is unreadable before repair"
        );

        let zip1 = watch_dir.path().join("Interrupted_Session.zip");
        write_test_zip(
            &zip1,
            &[
                (
                    "Empty_2026-11-08_08-00-00_to_2026-11-08_08-00-01_UTC-0800.m4a",
                    b"",
                ),
                (
                    "Recording_3_2026-11-08_09-00-21_to_2026-11-08_09-21-51_UTC-0800.m4a",
                    &unfinalized_b1,
                ),
                (
                    "Recording_3_2026-11-08_09-21-51_to_2026-11-08_09-39-19_UTC-0800.m4a",
                    &b2,
                ),
            ],
        );

        let settings = effective(&state, "u").await.unwrap();
        let r1 = scan_user(&state, "u", watch_dir.path(), &settings)
            .await
            .unwrap();
        assert_eq!(r1.merged, 1);
        assert!(r1.errors.is_empty(), "errors: {:?}", r1.errors);

        let exported1 = export_dir
            .path()
            .join("2026-11-08_09-00-21_to_09-39-19.m4a");
        assert!(exported1.exists());
        let probe1 = media::probe(&state.config.ffprobe, &exported1)
            .await
            .unwrap();
        assert!(
            probe1.duration_ms >= 1800,
            "both repaired unfinalized segment and valid segment are merged: {}",
            probe1.duration_ms
        );

        let zip2 = watch_dir.path().join("Standalone_Unfinalized.zip");
        write_test_zip(
            &zip2,
            &[(
                "Standalone_2026-11-08_10-00-00_to_2026-11-08_10-15-00_UTC-0800.m4a",
                &unfinalized_b1,
            )],
        );
        let r2 = scan_user(&state, "u", watch_dir.path(), &settings)
            .await
            .unwrap();
        assert_eq!(r2.merged, 1);
        assert!(r2.errors.is_empty(), "errors: {:?}", r2.errors);
        let exported2 = export_dir
            .path()
            .join("2026-11-08_10-00-00_to_10-15-00.m4a");
        assert!(exported2.exists());
        let probe2 = media::probe(&state.config.ffprobe, &exported2)
            .await
            .unwrap();
        assert!(
            probe2.duration_ms >= 800,
            "standalone unfinalized segment repaired without donor: {}",
            probe2.duration_ms
        );

        let zip3 = watch_dir.path().join("All_Garbage.zip");
        write_test_zip(
            &zip3,
            &[(
                "Broken_2026-11-08_11-00-00_to_2026-11-08_11-05-00_UTC-0800.m4a",
                b"not audio",
            )],
        );
        let r3 = scan_user(&state, "u", watch_dir.path(), &settings)
            .await
            .unwrap();
        assert_eq!(r3.merged, 0);
        assert_eq!(r3.errors.len(), 1);
        assert!(r3.errors[0].contains("has no readable audio"));
    }

    fn filetime_minus_5s() -> SystemTime {
        SystemTime::now() - Duration::from_secs(5)
    }
}
