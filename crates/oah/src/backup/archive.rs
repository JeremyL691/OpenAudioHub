//! Backup archives: builds the zip for a backup job, the job handler, the download route and cleanup.
//! Layout and rules are in spec/export-backup.md.

use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::Relaxed};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::{Path as UrlPath, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use tokio_util::io::ReaderStream;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

use super::{JobRow, RETENTION_MS, RecRow, latest_transcripts, live_recordings, summaries};
use crate::AppState;
use crate::auth::CurrentUser;
use crate::db::now_ms;
use crate::error::{ApiResult, AppError};
use crate::jobs::{self, Job, Outcome};
use crate::time;

/// Folder under the storage root that holds finished archives.
pub(super) const DIR: &str = "backups";
const STALL: Duration = Duration::from_secs(300);
const CEILING: Duration = Duration::from_secs(3 * 3600);
const MAX_ATTEMPTS: i64 = 3;

/// Why a build produced no archive.
pub(super) enum Fail {
    Stalled,
    /// Audio was missing or unreadable for this many recordings. Never retried.
    Missing(usize),
    Other(String),
}

impl Fail {
    fn message(&self) -> String {
        match self {
            Fail::Stalled => format!(
                "Export job stalled: no progress for {}ms",
                STALL.as_millis()
            ),
            Fail::Missing(n) => format!(
                "Export incomplete: audio was missing or unreadable for {n} recording(s). The archive was discarded."
            ),
            Fail::Other(message) => message.clone(),
        }
    }
}

fn app_fail(e: AppError) -> Fail {
    Fail::Other(e.source.unwrap_or(e.message))
}

fn internal<E: std::fmt::Display>(e: E) -> Fail {
    Fail::Other(e.to_string())
}

/// One zip entry. Audio is stored as is; everything else is deflated.
enum Entry {
    Audio { name: String, src: PathBuf },
    Bytes { name: String, data: Vec<u8> },
}

/// `<start as ISO-8601 UTC with ':' and '.' as '-'>_<id>`.
pub(super) fn folder_name(start: i64, id: &str) -> String {
    format!("{}_{id}", time::iso(start).replace([':', '.'], "-"))
}

/// `mp3` for uploads; otherwise the stored file's extension, or `mp3` when there is none.
fn audio_ext(r: &RecRow) -> String {
    if r.plaud_file_id.starts_with("uploaded-") {
        return "mp3".into();
    }
    let ext = Path::new(&r.storage_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ext.is_empty() { "mp3".into() } else { ext }
}

/// Copies `src` into `dst` in chunks, counting progress and stopping when cancelled.
fn copy_counted<R: Read, W: Write>(
    src: &mut R,
    dst: &mut W,
    progress: &AtomicU64,
    cancel: &AtomicBool,
) -> std::io::Result<()> {
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        if cancel.load(Relaxed) {
            return Err(std::io::Error::other("cancelled"));
        }
        let n = src.read(&mut buf)?;
        if n == 0 {
            return Ok(());
        }
        dst.write_all(&buf[..n])?;
        progress.fetch_add(n as u64, Relaxed);
    }
}

fn put(
    zip: &mut ZipWriter<File>,
    entry: &Entry,
    progress: &AtomicU64,
    cancel: &AtomicBool,
) -> std::io::Result<()> {
    match entry {
        Entry::Audio { name, src } => {
            zip.start_file(
                name.as_str(),
                SimpleFileOptions::default().compression_method(CompressionMethod::Stored),
            )
            .map_err(std::io::Error::other)?;
            copy_counted(&mut File::open(src)?, zip, progress, cancel)
        }
        Entry::Bytes { name, data } => {
            let options = SimpleFileOptions::default()
                .compression_method(CompressionMethod::Deflated)
                .compression_level(Some(6));
            zip.start_file(name.as_str(), options)
                .map_err(std::io::Error::other)?;
            copy_counted(&mut data.as_slice(), zip, progress, cancel)
        }
    }
}

/// Writes entries on a blocking thread. The zip is moved in and back out, so a large library never sits in memory at once.
async fn write_entries(
    zip: ZipWriter<File>,
    entries: Vec<Entry>,
    progress: Arc<AtomicU64>,
    cancel: Arc<AtomicBool>,
) -> Result<ZipWriter<File>, String> {
    tokio::task::spawn_blocking(move || {
        let mut zip = zip;
        for entry in &entries {
            put(&mut zip, entry, &progress, &cancel)?;
        }
        Ok::<_, std::io::Error>(zip)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

/// Writes the whole archive to `tmp`. Fails with `Missing` (after writing) if any audio is absent.
async fn write_archive(
    state: &AppState,
    user_id: &str,
    tmp: &Path,
    progress: Arc<AtomicU64>,
    cancel: Arc<AtomicBool>,
) -> Result<usize, Fail> {
    let rows = live_recordings(&state.db, user_id)
        .await
        .map_err(app_fail)?;
    let transcripts = latest_transcripts(&state.db, user_id)
        .await
        .map_err(app_fail)?;
    let sums = summaries(&state.db, user_id).await.map_err(app_fail)?;
    let key = &state.config.field_key;
    let mut zip = ZipWriter::new(File::create(tmp).map_err(internal)?);
    let mut manifest = Vec::with_capacity(rows.len());
    let mut missing = 0usize;

    for r in &rows {
        let folder = folder_name(r.start_time, &r.id);
        let mut entries = Vec::new();

        // Object-storage audio is fetched to a temporary file that lives until this recording is written.
        let fetched = state
            .storage
            .materialize(&r.storage_type, &r.storage_path)
            .await
            .ok();
        let mut audio = json!({ "included": false, "path": null });
        if let Some(file) = &fetched {
            let name = format!("{folder}/audio.{}", audio_ext(r));
            audio = json!({ "included": true, "path": name });
            entries.push(Entry::Audio {
                name,
                src: file.path().to_path_buf(),
            });
        } else {
            missing += 1;
            audio["reason"] = json!("Audio file not found in storage");
        }

        let mut transcript = json!({ "included": false, "path": null });
        let mut timeline = json!({ "included": false, "path": null });
        if let Some(t) = transcripts.get(&r.id) {
            let text = key.decrypt(&t.text).map_err(internal)?;
            let name = format!("{folder}/transcript.txt");
            entries.push(Entry::Bytes {
                name: name.clone(),
                data: text.into_bytes(),
            });
            transcript = json!({ "included": true, "path": name });
            // Only the app's own pipeline writes a timeline the archive carries.
            if let (true, Some(raw)) = (t.source == "openaudiohub", t.timeline.as_deref()) {
                let parsed_raw: Value = serde_json::from_str(raw).map_err(internal)?;
                let parsed = key.decrypt_json(&parsed_raw).map_err(internal)?;
                let (segments, processing) = match parsed {
                    Value::Object(mut o) => (
                        o.remove("segments").unwrap_or(json!([])),
                        o.remove("processing").unwrap_or(Value::Null),
                    ),
                    other => (other, Value::Null),
                };
                let body = json!({
                    "schema_version": 1,
                    "timestamp_source": t.timeline_source,
                    "processing": processing,
                    "segments": segments,
                });
                let name = format!("{folder}/timeline.json");
                entries.push(Entry::Bytes {
                    name: name.clone(),
                    data: serde_json::to_vec_pretty(&body).map_err(internal)?,
                });
                timeline = json!({ "included": true, "path": name });
            }
        }

        let mut summary = json!({ "included": false, "path": null });
        if let Some(s) = sums.get(&r.id) {
            let decrypted = super::decrypt_summary(key, s).map_err(app_fail)?;
            let mut body = super::summary_json(&decrypted);
            body["provider"] = json!(s.provider);
            body["model"] = json!(s.model);
            body["createdAt"] = json!(time::iso(s.created_at));
            let name = format!("{folder}/summary.json");
            entries.push(Entry::Bytes {
                name: name.clone(),
                data: serde_json::to_vec_pretty(&body).map_err(internal)?,
            });
            summary = json!({ "included": true, "path": name });
        }

        manifest.push(json!({
            "id": r.id,
            "filename": key.decrypt(&r.filename).map_err(internal)?,
            "startTime": time::iso(r.start_time),
            "endTime": time::iso(r.end_time),
            "duration": r.duration,
            "filesize": r.filesize,
            "deviceSn": r.device_sn,
            "audio": audio,
            "transcript": transcript,
            "timeline": timeline,
            "summary": summary,
        }));
        zip = write_entries(zip, entries, progress.clone(), cancel.clone())
            .await
            .map_err(Fail::Other)?;
    }

    let document = json!({
        "version": "2.0",
        "createdAt": time::iso(now_ms()),
        "userId": user_id,
        "audio_complete": missing == 0,
        "missing_audio_count": missing,
        "recordings": manifest,
    });
    let data = serde_json::to_vec_pretty(&document).map_err(internal)?;
    let manifest_entry = vec![Entry::Bytes {
        name: "manifest.json".into(),
        data,
    }];
    zip = write_entries(zip, manifest_entry, progress, cancel)
        .await
        .map_err(Fail::Other)?;
    if missing > 0 {
        return Err(Fail::Missing(missing));
    }
    let file = zip.finish().map_err(internal)?;
    file.sync_all().map_err(internal)?;
    Ok(rows.len())
}

/// Builds the archive at `tmp`. A watchdog cancels the build after 5 minutes without progress,
/// and the whole build is capped at 3 hours.
pub(super) async fn build(state: &AppState, user_id: &str, tmp: &Path) -> Result<usize, Fail> {
    let progress = Arc::new(AtomicU64::new(0));
    let cancel = Arc::new(AtomicBool::new(false));
    let stalled = Arc::new(AtomicBool::new(false));
    let watchdog = tokio::spawn({
        let (progress, cancel, stalled) = (progress.clone(), cancel.clone(), stalled.clone());
        async move {
            let (mut seen, mut since) = (progress.load(Relaxed), Instant::now());
            loop {
                tokio::time::sleep(Duration::from_secs(5)).await;
                let now = progress.load(Relaxed);
                if now != seen {
                    (seen, since) = (now, Instant::now());
                } else if since.elapsed() >= STALL {
                    stalled.store(true, Relaxed);
                    cancel.store(true, Relaxed);
                    return;
                }
            }
        }
    });
    let result = match tokio::time::timeout(
        CEILING,
        write_archive(state, user_id, tmp, progress, cancel.clone()),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => {
            cancel.store(true, Relaxed);
            Err(Fail::Other(format!(
                "Export job exceeded max duration of {}ms",
                CEILING.as_millis()
            )))
        }
    };
    watchdog.abort();
    match result {
        Err(_) if stalled.load(Relaxed) => Err(Fail::Stalled),
        other => other,
    }
}

async fn set_status(state: &AppState, id: &str, status: &str) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE export_jobs SET status = ? WHERE id = ?")
        .bind(status)
        .bind(id)
        .execute(&state.db)
        .await?;
    Ok(())
}

async fn fail_job(state: &AppState, id: &str, message: &str) {
    let result =
        sqlx::query("UPDATE export_jobs SET status = 'failed', error_message = ? WHERE id = ?")
            .bind(message)
            .bind(id)
            .execute(&state.db)
            .await;
    if let Err(e) = result {
        tracing::error!(job = id, error = %e, "could not record export failure");
    }
}

/// Retries while attempts remain; after the last one the job is failed for good.
async fn retry_or_fail(state: &AppState, job: &Job, id: &str, message: String) -> Outcome {
    if job.attempts >= MAX_ATTEMPTS {
        fail_job(state, id, &message).await;
        return Outcome::Failed {
            code: "EXPORT_FAILED",
            message,
        };
    }
    if let Err(e) = set_status(state, id, "pending").await {
        tracing::error!(job = id, error = %e, "could not reset export job");
    }
    Outcome::Retry {
        code: "EXPORT_FAILED",
        message,
        after: jobs::backoff(job.attempts),
    }
}

/// Marks the export row completed, sets its retention, and copies scheduled archives to the backup folder.
async fn finish_ok(
    state: &AppState,
    row: &JobRow,
    id: &str,
    tmp: &Path,
    count: usize,
) -> Result<(), String> {
    let key = format!("{DIR}/{id}.zip");
    let dest = state.config.storage_root.join(&key);
    tokio::fs::rename(tmp, &dest)
        .await
        .map_err(|e| e.to_string())?;
    let size = tokio::fs::metadata(&dest)
        .await
        .map_err(|e| e.to_string())?
        .len();
    let now = now_ms();
    sqlx::query(
        "UPDATE export_jobs SET status = 'completed', storage_key = ?, file_size = ?, recording_count = ?, \
         error_message = NULL, completed_at = ?, expires_at = ? WHERE id = ?",
    )
    .bind(&key)
    .bind(size as i64)
    .bind(count as i64)
    .bind(now)
    .bind(now + RETENTION_MS)
    .bind(id)
    .execute(&state.db)
    .await
    .map_err(|e| e.to_string())?;
    if row.kind == "scheduled" {
        if let Err(e) = super::schedule::copy_to_folder(state, &row.user_id, &dest).await {
            tracing::warn!(job = id, error = %e, "scheduled backup copy failed");
        }
    } else {
        crate::notify::export_ready(state, &row.user_id).await;
    }
    Ok(())
}

/// Runs one backup job from the queue. Safe to run twice: a finished job is left alone.
pub(super) async fn run(state: &AppState, job: Job) -> Outcome {
    let Some(id) = job
        .payload()
        .get("exportJobId")
        .and_then(Value::as_str)
        .map(str::to_owned)
    else {
        return Outcome::Done;
    };
    let row = match super::load_job(&state.db, &id).await {
        Ok(Some(row)) => row,
        Ok(None) => return Outcome::Done,
        Err(e) => {
            return Outcome::Retry {
                code: "INTERNAL_ERROR",
                message: e.message,
                after: jobs::backoff(job.attempts),
            };
        }
    };
    if row.status == "completed" || row.status == "failed" {
        return Outcome::Done;
    }
    if let Err(e) = set_status(state, &id, "processing").await {
        return Outcome::Retry {
            code: "INTERNAL_ERROR",
            message: e.to_string(),
            after: jobs::backoff(job.attempts),
        };
    }

    let dir = state.config.storage_root.join(DIR);
    if let Err(e) = tokio::fs::create_dir_all(&dir).await {
        return retry_or_fail(state, &job, &id, e.to_string()).await;
    }
    let tmp = dir.join(format!(".{id}.partial"));
    match build(state, &row.user_id, &tmp).await {
        Ok(count) => match finish_ok(state, &row, &id, &tmp, count).await {
            Ok(()) => Outcome::Done,
            Err(message) => {
                let _ = tokio::fs::remove_file(&tmp).await;
                retry_or_fail(state, &job, &id, message).await
            }
        },
        Err(Fail::Missing(n)) => {
            // The archive is discarded, and this failure is final.
            let _ = tokio::fs::remove_file(&tmp).await;
            let message = Fail::Missing(n).message();
            fail_job(state, &id, &message).await;
            Outcome::Failed {
                code: "EXPORT_INCOMPLETE",
                message,
            }
        }
        Err(fail) => {
            let _ = tokio::fs::remove_file(&tmp).await;
            retry_or_fail(state, &job, &id, fail.message()).await
        }
    }
}

/// Removes expired archives (and their rows). A row stays until its file is gone.
pub(super) async fn cleanup(state: &AppState) -> Result<(), String> {
    let expired: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT id, storage_key FROM export_jobs WHERE status = 'completed' AND expires_at < ?",
    )
    .bind(now_ms())
    .fetch_all(&state.db)
    .await
    .map_err(|e| e.to_string())?;
    for (id, key) in expired {
        if let Some(key) = key {
            match tokio::fs::remove_file(state.config.storage_root.join(&key)).await {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => {
                    tracing::warn!(job = id, error = %e, "could not delete expired archive");
                    continue;
                }
            }
        }
        sqlx::query("DELETE FROM export_jobs WHERE id = ?")
            .bind(&id)
            .execute(&state.db)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Streams a finished archive with its exact Content-Length.
pub(super) async fn download(
    State(state): State<AppState>,
    user: CurrentUser,
    UrlPath(id): UrlPath<String>,
) -> ApiResult<Response> {
    let job: JobRow = super::owned_job(&state, &user.id, &id).await?;
    if job.status == "completed" && job.expires_at.is_some_and(|e| e < now_ms()) {
        return Err(AppError::not_found("NOT_FOUND", "Export has expired"));
    }
    if job.status != "completed" {
        return Err(AppError::new(
            StatusCode::CONFLICT,
            "CONFLICT",
            "Export is not ready for download",
        ));
    }
    let key = job
        .storage_key
        .ok_or_else(|| AppError::internal("completed export has no archive"))?;
    let file = tokio::fs::File::open(state.config.storage_root.join(&key))
        .await
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                AppError::not_found("NOT_FOUND", "Export file is missing")
            } else {
                AppError::internal(e)
            }
        })?;
    let size = file.metadata().await.map_err(AppError::internal)?.len();
    let headers = [
        (header::CONTENT_TYPE, "application/zip".to_owned()),
        (header::CONTENT_LENGTH, size.to_string()),
        (
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"openaudiohub-export-{id}.zip\""),
        ),
    ];
    Ok((
        headers,
        Body::from_stream(ReaderStream::with_capacity(file, 64 * 1024)),
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::db::open_memory;

    /// A user with one uploaded recording (5 bytes of audio) and one transcript.
    async fn seeded(dir: &Path) -> AppState {
        let state = AppState::new(Config::for_tests(dir), open_memory().await.unwrap());
        sqlx::query(
            "INSERT INTO users (id, email, created_at, updated_at) VALUES ('u', 'u@x.test', 0, 0)",
        )
        .execute(&state.db)
        .await
        .unwrap();
        let title = state.config.field_key.encrypt("Team sync");
        sqlx::query(
            "INSERT INTO recordings (id, user_id, device_sn, plaud_file_id, filename, duration, start_time, end_time, \
             filesize, file_md5, storage_type, storage_path, plaud_version, created_at, updated_at) \
             VALUES ('rec_1', 'u', 'local', 'uploaded-1', ?, 3000, 1000, 4000, 5, '', 'local', 'u/uploaded-1.mp3', '1', 0, 0)",
        )
        .bind(title)
        .execute(&state.db)
        .await
        .unwrap();
        let text = state.config.field_key.encrypt("hello");
        sqlx::query(
            "INSERT INTO transcriptions (id, recording_id, user_id, text, provider, model, created_at) \
             VALUES ('t1', 'rec_1', 'u', ?, 'p', 'm', 0)",
        )
        .bind(text)
        .execute(&state.db)
        .await
        .unwrap();
        std::fs::create_dir_all(state.config.storage_root.join("u")).unwrap();
        std::fs::write(state.config.storage_root.join("u/uploaded-1.mp3"), b"abcde").unwrap();
        state
    }

    #[test]
    fn folder_name_replaces_colons_and_dots() {
        assert_eq!(folder_name(1000, "rec_1"), "1970-01-01T00-00-01-000Z_rec_1");
    }

    #[tokio::test]
    async fn archive_has_manifest_and_one_folder_per_recording() {
        let dir = tempfile::tempdir().unwrap();
        let state = seeded(dir.path()).await;
        let tmp = dir.path().join("out.zip");
        let count = match build(&state, "u", &tmp).await {
            Ok(c) => c,
            Err(f) => panic!("{}", f.message()),
        };
        assert_eq!(count, 1);

        let mut zip = zip::ZipArchive::new(File::open(&tmp).unwrap()).unwrap();
        let folder = "1970-01-01T00-00-01-000Z_rec_1";
        let mut bytes = Vec::new();
        {
            let mut audio = zip.by_name(&format!("{folder}/audio.mp3")).unwrap();
            assert_eq!(audio.compression(), CompressionMethod::Stored);
            audio.read_to_end(&mut bytes).unwrap();
        }
        assert_eq!(bytes, b"abcde");
        let mut text = String::new();
        zip.by_name(&format!("{folder}/transcript.txt"))
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
        assert_eq!(text, "hello");
        assert!(zip.by_name(&format!("{folder}/timeline.json")).is_err());

        let mut manifest = String::new();
        zip.by_name("manifest.json")
            .unwrap()
            .read_to_string(&mut manifest)
            .unwrap();
        let manifest: Value = serde_json::from_str(&manifest).unwrap();
        assert_eq!(manifest["version"], "2.0");
        assert_eq!(manifest["audio_complete"], true);
        let rec = &manifest["recordings"][0];
        assert_eq!(rec["filename"], "Team sync");
        assert_eq!(rec["audio"]["path"], format!("{folder}/audio.mp3"));
        assert_eq!(rec["transcript"]["included"], true);
        assert_eq!(rec["timeline"]["included"], false);
        assert_eq!(rec["summary"], json!({ "included": false, "path": null }));
    }

    #[tokio::test]
    async fn missing_audio_fails_the_build() {
        let dir = tempfile::tempdir().unwrap();
        let state = seeded(dir.path()).await;
        std::fs::remove_file(state.config.storage_root.join("u/uploaded-1.mp3")).unwrap();
        let tmp = dir.path().join("out.zip");
        match build(&state, "u", &tmp).await {
            Err(Fail::Missing(1)) => {}
            _ => panic!("expected Missing(1)"),
        }
    }
}
