//! Audio download and storage, and Plaud's own transcript and summary import.

use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::api::{self, Client};
use super::raw_opus;
use super::sync::ItemError;
use super::v4::AudioPreference;
use crate::{AppState, ids};

/// Temporary file removed automatically on drop unless disarmed.
pub(crate) struct TempPath(Option<PathBuf>);

impl TempPath {
    pub(crate) fn new(path: PathBuf) -> Self {
        Self(Some(path))
    }

    pub(crate) fn path(&self) -> &Path {
        self.0
            .as_deref()
            .expect("TempPath used after being disarmed")
    }

    pub(crate) fn disarm(&mut self) -> Option<PathBuf> {
        self.0.take()
    }
}

impl Drop for TempPath {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// A downloaded Plaud audio object stored in a temporary `.partial` file.
pub(crate) struct DownloadedTemp {
    pub temp: TempPath,
    pub byte_len: i64,
    pub file_md5: String,
}

/// Where a downloaded recording's audio went: the backend it was written to and its object key.
pub struct Stored {
    pub storage_type: &'static str,
    pub key: String,
    pub peaks: Option<Vec<f64>>,
    pub byte_len: i64,
    pub file_md5: String,
    pub remuxed: bool,
}

/// One Plaud recording part contributing to a multi-part recording's transcript and summary.
#[derive(Debug, Clone)]
pub(crate) struct ContentPart {
    pub plaud_file_id: String,
    pub audio_duration_ms: i64,
}

/// Downloads a recording's audio to a temporary `.partial` file under `storage_root/<user_id>`.
/// The file is fsynced before return and cleaned up automatically if the returned handle is dropped.
pub(crate) async fn download_to_temp(
    state: &AppState,
    user_id: &str,
    client: &Client,
    file_id: &str,
    pref: AudioPreference,
) -> Result<DownloadedTemp, ItemError> {
    let url = match pref {
        AudioPreference::Default => client.audio_url(file_id).await?,
        other => client.audio_url_with(file_id, other).await?,
    };
    let mut resp = api::fetch(&url).await?;
    let dir = state.config.storage_root.join(user_id);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|_| ItemError::Failed("could not create the storage folder".into()))?;
    let temp = TempPath::new(dir.join(format!(".plaud-{}.partial", ids::token_hex(8))));
    let (byte_len, file_md5) = write_stream(&mut resp, temp.path()).await?;
    Ok(DownloadedTemp {
        temp,
        byte_len,
        file_md5,
    })
}

/// Downloads a recording's original audio to the active storage backend and returns where it went.
/// The bytes go to a temporary file, are fsynced, and only then get their final name.
pub async fn store_audio(
    state: &AppState,
    user_id: &str,
    client: &Client,
    file_id: &str,
) -> Result<Stored, ItemError> {
    let downloaded =
        download_to_temp(state, user_id, client, file_id, AudioPreference::Default).await?;
    stage_downloaded(state, user_id, file_id, downloaded).await
}

/// Names the finished download after its bytes and moves it into storage.
async fn stage_downloaded(
    state: &AppState,
    user_id: &str,
    file_id: &str,
    downloaded: DownloadedTemp,
) -> Result<Stored, ItemError> {
    let head = read_head(downloaded.temp.path()).await?;
    let mut ext = sniff_ext(&head);
    let mut final_temp = downloaded.temp;
    let mut final_len = downloaded.byte_len;
    let mut final_md5 = downloaded.file_md5;
    let mut remuxed = false;

    if !raw_opus::is_known_container(&head) {
        let dir = final_temp
            .path()
            .parent()
            .unwrap_or(&state.config.storage_root);
        let muxed = TempPath::new(dir.join(format!(".plaud-ogg-{}.partial", ids::token_hex(8))));
        match raw_opus::wrap_if_raw_opus(&state.config.ffprobe, final_temp.path(), muxed.path())
            .await
        {
            Ok(Some((ogg_len, ogg_md5))) => {
                // Dropping the old `final_temp` unlinks the raw `.partial` immediately.
                final_temp = muxed;
                final_len = ogg_len;
                final_md5 = ogg_md5;
                ext = "ogg";
                remuxed = true;
            }
            Ok(None) => {}
            Err(e) => {
                tracing::warn!(file_id, error = %e, "wrapping raw Opus audio into Ogg failed");
            }
        }
    }

    stage_prepared_audio(
        state, user_id, file_id, ext, final_temp, final_len, final_md5, remuxed,
    )
    .await
}

/// Computes waveform peaks and moves a prepared temporary audio file into active storage.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn stage_prepared_audio(
    state: &AppState,
    user_id: &str,
    stem_id: &str,
    ext: &str,
    mut temp: TempPath,
    byte_len: i64,
    file_md5: String,
    remuxed: bool,
) -> Result<Stored, ItemError> {
    let key = free_key(state, user_id, stem_id, ext).await?;
    let mime = crate::routes::recordings::mime_for(ext);
    let peaks =
        crate::routes::recordings::media::compute_peaks(&state.config.ffmpeg, temp.path(), 256)
            .await;
    state
        .storage
        .store_staged(&key, temp.path(), Some(mime))
        .await
        .map_err(|e| ItemError::Failed(format!("could not store the audio: {e}")))?;
    temp.disarm();
    Ok(Stored {
        storage_type: state.storage.active_type(),
        key,
        peaks,
        byte_len,
        file_md5,
        remuxed,
    })
}

async fn write_stream(
    resp: &mut reqwest::Response,
    path: &Path,
) -> Result<(i64, String), ItemError> {
    use md5::Digest;
    let mut file = tokio::fs::File::create(path)
        .await
        .map_err(|_| ItemError::Failed("could not write the audio".into()))?;
    let mut hasher = md5::Md5::new();
    let mut byte_len: i64 = 0;
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|_| ItemError::Failed("the download was interrupted".into()))?
    {
        file.write_all(&chunk)
            .await
            .map_err(|_| ItemError::Failed("could not write the audio".into()))?;
        hasher.update(&chunk);
        byte_len = byte_len.saturating_add(i64::try_from(chunk.len()).unwrap_or(i64::MAX));
    }
    file.flush()
        .await
        .map_err(|_| ItemError::Failed("could not write the audio".into()))?;
    file.sync_all()
        .await
        .map_err(|_| ItemError::Failed("could not write the audio".into()))?;
    Ok((byte_len, hex::encode(hasher.finalize())))
}

pub(crate) async fn read_head(path: &Path) -> Result<Vec<u8>, ItemError> {
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|_| ItemError::Failed("could not read the audio".into()))?;
    let mut buf = vec![0u8; 64];
    let n = file
        .read(&mut buf)
        .await
        .map_err(|_| ItemError::Failed("could not read the audio".into()))?;
    buf.truncate(n);
    Ok(buf)
}

/// `<user>/<file>.<ext>`, with ` (2)`, ` (3)` before the extension when the key is taken, up to 100 tries.
pub(crate) async fn free_key(
    state: &AppState,
    user_id: &str,
    file_id: &str,
    ext: &str,
) -> Result<String, ItemError> {
    for n in 1..=100 {
        let stem = if n == 1 {
            file_id.to_owned()
        } else {
            format!("{file_id} ({n})")
        };
        let key = format!("{user_id}/{stem}.{ext}");
        let taken: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM recordings WHERE storage_path = ?")
                .bind(&key)
                .fetch_one(&state.db)
                .await?;
        let on_disk = match state
            .storage
            .head_size(state.storage.active_type(), &key)
            .await
        {
            Ok(_) => true,
            Err(crate::storage::StorageError::NotFound) => false,
            Err(_) => true,
        };
        if taken == 0 && !on_disk {
            return Ok(key);
        }
    }
    Err(ItemError::Failed("no free file name for the audio".into()))
}

/// The extension from the bytes. Plaud often labels Ogg/Opus files as `.mp3`, so the bytes win.
pub fn sniff_ext(head: &[u8]) -> &'static str {
    if head.starts_with(b"ID3") || (head.len() >= 2 && head[0] == 0xFF && head[1] & 0xE0 == 0xE0) {
        "mp3"
    } else if head.starts_with(b"OggS") {
        if head.windows(8).any(|w| w == b"OpusHead") {
            "opus"
        } else {
            "ogg"
        }
    } else if head.len() >= 12 && &head[0..4] == b"RIFF" && &head[8..12] == b"WAVE" {
        "wav"
    } else if head.len() >= 8 && &head[4..8] == b"ftyp" {
        "m4a"
    } else if head.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        "webm"
    } else if head.starts_with(b"fLaC") {
        "flac"
    } else {
        "mp3"
    }
}

/// Fills a missing Plaud transcript and summary for a stored recording. Returns whether anything was added.
pub async fn import_content(
    state: &AppState,
    user_id: &str,
    client: &Client,
    recording_id: &str,
    file_id: &str,
) -> Result<bool, ItemError> {
    let has_transcript: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM transcriptions WHERE recording_id = ? AND source = 'plaud')",
    )
    .bind(recording_id)
    .fetch_one(&state.db)
    .await?;
    // An empty row left by an older run does not count, so Plaud's summary can still fill it.
    let has_summary: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM ai_enhancements WHERE recording_id = ? AND has_content = 1)",
    )
    .bind(recording_id)
    .fetch_one(&state.db)
    .await?;
    if has_transcript && has_summary {
        return Ok(false);
    }
    let detail = client.detail(file_id).await?;
    let items = detail
        .get("content_list")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let now = crate::db::now_ms();
    let mut imported = false;
    let mut transcript_added = false;

    if !has_transcript && let Some(link) = ready_link(&items, is_transcript_item) {
        let body = fetch_body(&link).await?;
        if let Some(text) = transcript_text(&body) {
            let timeline = transcript_timeline(&body);
            if save_plaud_transcript(
                state,
                user_id,
                recording_id,
                &text,
                timeline.as_deref(),
                now,
            )
            .await?
            {
                imported = true;
                transcript_added = true;
            }
        }
    }

    if !has_summary && let Some(v) = fetch_summary_for_detail(&detail, &items).await? {
        let parsed = parse_summary_fields(&v);
        if save_plaud_summary(state, user_id, recording_id, &parsed, now).await? {
            imported = true;
        }
    }
    // Plaud's transcript arrives outside the transcription job, so the summary step runs from
    // the follow-up job the import queued above.
    if transcript_added {
        crate::summary::followup::notify(state);
    }
    Ok(imported)
}

/// Fills missing Plaud transcript and summary for a multi-part merged recording.
/// Inserts stitched transcript or summary only once every part has ready Plaud content.
pub(crate) async fn import_content_parts(
    state: &AppState,
    user_id: &str,
    client: &Client,
    recording_id: &str,
    parts: &[ContentPart],
) -> Result<bool, ItemError> {
    if parts.is_empty() {
        return Ok(false);
    }
    if parts.len() == 1 {
        return import_content(
            state,
            user_id,
            client,
            recording_id,
            &parts[0].plaud_file_id,
        )
        .await;
    }

    let has_transcript: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM transcriptions WHERE recording_id = ? AND source = 'plaud')",
    )
    .bind(recording_id)
    .fetch_one(&state.db)
    .await?;
    let has_summary: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM ai_enhancements WHERE recording_id = ? AND has_content = 1)",
    )
    .bind(recording_id)
    .fetch_one(&state.db)
    .await?;
    if has_transcript && has_summary {
        return Ok(false);
    }

    let mut details = Vec::with_capacity(parts.len());
    for part in parts {
        details.push(client.detail(&part.plaud_file_id).await?);
    }

    let now = crate::db::now_ms();
    let mut imported = false;
    let mut transcript_added = false;

    if !has_transcript {
        let mut links = Vec::with_capacity(details.len());
        let mut all_ready = true;
        for detail in &details {
            let items = detail
                .get("content_list")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            match ready_link(items, is_transcript_item) {
                Some(link) => links.push(link),
                None => {
                    all_ready = false;
                    break;
                }
            }
        }
        if all_ready {
            let mut part_transcripts = Vec::with_capacity(links.len());
            let mut all_present = true;
            for (link, part) in links.iter().zip(parts.iter()) {
                let body = fetch_body(link).await?;
                match transcript_text(&body) {
                    Some(text) => {
                        part_transcripts.push(PartTranscript {
                            text,
                            timeline: transcript_timeline(&body),
                            audio_duration_ms: part.audio_duration_ms.max(0),
                        });
                    }
                    None => {
                        all_present = false;
                        break;
                    }
                }
            }
            if all_present
                && let Some((stitched_text, stitched_timeline)) =
                    stitch_part_transcripts(&part_transcripts)
                && save_plaud_transcript(
                    state,
                    user_id,
                    recording_id,
                    &stitched_text,
                    stitched_timeline.as_deref(),
                    now,
                )
                .await?
            {
                imported = true;
                transcript_added = true;
            }
        }
    }

    if !has_summary {
        let mut part_summaries = Vec::with_capacity(details.len());
        let mut all_ready = true;
        for detail in &details {
            let items = detail
                .get("content_list")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            match fetch_summary_for_detail(detail, items).await? {
                Some(v) => {
                    let parsed = parse_summary_fields(&v);
                    if parsed.is_empty() {
                        all_ready = false;
                        break;
                    }
                    part_summaries.push(parsed);
                }
                None => {
                    all_ready = false;
                    break;
                }
            }
        }
        if all_ready {
            let stitched = stitch_part_summaries(&part_summaries);
            if save_plaud_summary(state, user_id, recording_id, &stitched, now).await? {
                imported = true;
            }
        }
    }

    if transcript_added {
        crate::summary::followup::notify(state);
    }
    Ok(imported)
}

struct PartTranscript {
    text: String,
    timeline: Option<Vec<Value>>,
    audio_duration_ms: i64,
}

fn stitch_part_transcripts(parts: &[PartTranscript]) -> Option<(String, Option<Vec<Value>>)> {
    if parts.is_empty() {
        return None;
    }
    let texts: Vec<&str> = parts
        .iter()
        .map(|p| p.text.trim())
        .filter(|t| !t.is_empty())
        .collect();
    if texts.len() != parts.len() {
        return None;
    }
    let joined_text = texts.join("\n\n");

    let stitched_timeline = if parts.iter().all(|p| p.timeline.is_some()) {
        let mut out = Vec::new();
        let mut offset_ms = 0i64;
        for part in parts {
            if let Some(items) = &part.timeline {
                for item in items {
                    let mut entry = item.clone();
                    if let Some(start) = entry.get("start_ms").and_then(Value::as_i64) {
                        entry["start_ms"] = json!(start.saturating_add(offset_ms));
                    }
                    if let Some(end) = entry.get("end_ms").and_then(Value::as_i64) {
                        entry["end_ms"] = json!(end.saturating_add(offset_ms));
                    }
                    out.push(entry);
                }
            }
            offset_ms = offset_ms.saturating_add(part.audio_duration_ms.max(0));
        }
        (!out.is_empty()).then_some(out)
    } else {
        None
    };

    Some((joined_text, stitched_timeline))
}

struct ParsedSummary {
    text: String,
    key_points: Vec<Value>,
    action_items: Vec<Value>,
}

impl ParsedSummary {
    fn is_empty(&self) -> bool {
        self.text.is_empty() && self.key_points.is_empty() && self.action_items.is_empty()
    }
}

fn parse_summary_fields(v: &Value) -> ParsedSummary {
    ParsedSummary {
        text: first_str(v, &["ai_content", "summary", "content"])
            .map(|s| s.trim().to_owned())
            .unwrap_or_default(),
        key_points: list_of(v, &["key_points", "keyPoints", "highlights"]),
        action_items: list_of(v, &["action_items", "actionItems", "todos"]),
    }
}

fn stitch_part_summaries(parts: &[ParsedSummary]) -> ParsedSummary {
    let text = parts
        .iter()
        .map(|p| p.text.trim())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    let mut key_points = Vec::new();
    let mut action_items = Vec::new();
    for p in parts {
        key_points.extend(p.key_points.iter().cloned());
        action_items.extend(p.action_items.iter().cloned());
    }
    ParsedSummary {
        text,
        key_points,
        action_items,
    }
}

async fn save_plaud_transcript(
    state: &AppState,
    user_id: &str,
    recording_id: &str,
    text: &str,
    timeline: Option<&[Value]>,
    now: i64,
) -> Result<bool, ItemError> {
    let (tl_val, tl_src) = match timeline {
        Some(tl) if !tl.is_empty() => (
            Some(
                state
                    .config
                    .field_key
                    .encrypt_json(&Value::Array(tl.to_vec()))
                    .to_string(),
            ),
            Some("native"),
        ),
        _ => (None, None),
    };
    let transcript_id = ids::new_id();
    // The transcript and the work it owes commit together, so a process that stops between them
    // cannot leave a transcript whose follow-up was never recorded.
    let mut tx = crate::db::begin_write(&state.db).await?;
    let inserted = sqlx::query(
        "INSERT INTO transcriptions (id, recording_id, user_id, text, detected_language, transcription_type, provider, model, timeline, timeline_source, source, created_at) \
         VALUES (?, ?, ?, ?, NULL, 'server', 'plaud', 'plaud-native', ?, ?, 'plaud', ?) ON CONFLICT DO NOTHING",
    )
    .bind(&transcript_id)
    .bind(recording_id)
    .bind(user_id)
    .bind(state.config.field_key.encrypt(text))
    .bind(tl_val)
    .bind(tl_src)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    if inserted.rows_affected() == 1 {
        crate::summary::followup::enqueue_in(
            &mut *tx,
            user_id,
            recording_id,
            &transcript_id,
            "plaud",
        )
        .await?;
        tx.commit().await?;
        Ok(true)
    } else {
        tx.rollback().await?;
        Ok(false)
    }
}

async fn save_plaud_summary(
    state: &AppState,
    user_id: &str,
    recording_id: &str,
    summary: &ParsedSummary,
    now: i64,
) -> Result<bool, ItemError> {
    if summary.is_empty() {
        return Ok(false);
    }
    let key = &state.config.field_key;
    let res = sqlx::query(
        "INSERT INTO ai_enhancements (id, recording_id, user_id, summary, action_items, key_points, provider, model, source, prompt_id, language, created_at, has_content) \
         VALUES (?, ?, ?, ?, ?, ?, 'plaud', 'plaud-native', 'plaud', NULL, NULL, ?, 1) ON CONFLICT (recording_id, user_id) DO NOTHING",
    )
    .bind(ids::new_id())
    .bind(recording_id)
    .bind(user_id)
    .bind((!summary.text.is_empty()).then(|| key.encrypt(&summary.text)))
    .bind(
        key.encrypt_json(&Value::Array(summary.action_items.clone()))
            .to_string(),
    )
    .bind(
        key.encrypt_json(&Value::Array(summary.key_points.clone()))
            .to_string(),
    )
    .bind(now)
    .execute(&state.db)
    .await?;
    Ok(res.rows_affected() == 1)
}

async fn fetch_summary_for_detail(
    detail: &Value,
    items: &[Value],
) -> Result<Option<Value>, ItemError> {
    let inline = detail
        .get("pre_download_content_list")
        .and_then(Value::as_array)
        .and_then(|list| list.iter().find(|i| is_summary_item(i)))
        .and_then(|i| i.get("data_content"))
        .and_then(Value::as_str)
        .and_then(|s| parse_summary_body(s.as_bytes()));
    if inline.is_some() {
        return Ok(inline);
    }
    match ready_link(items, is_summary_item) {
        Some(link) => Ok(parse_summary_body(&fetch_body(&link).await?)),
        None => Ok(None),
    }
}

fn is_transcript_item(item: &Value) -> bool {
    item.get("data_id")
        .and_then(Value::as_str)
        .is_some_and(|id| id.starts_with("source_transaction:"))
        || item.get("data_type").and_then(Value::as_str) == Some("transaction")
}

/// The first item that matches and is ready (task status 1) and has a link.
fn ready_link(items: &[Value], matches: impl Fn(&Value) -> bool) -> Option<String> {
    items
        .iter()
        .find(|i| matches(i) && i.get("task_status").and_then(Value::as_i64) == Some(1))
        .and_then(|i| i.get("data_link"))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

async fn fetch_body(url: &str) -> Result<Vec<u8>, ItemError> {
    let mut resp = api::fetch(url).await?;
    let mut out = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|_| ItemError::Failed("the download was interrupted".into()))?
    {
        out.extend_from_slice(&chunk);
    }
    if out.starts_with(&[0x1f, 0x8b]) {
        return gunzip(&out)
            .ok_or_else(|| ItemError::Failed("compressed Plaud content could not be read".into()));
    }
    Ok(out)
}

/// Plaud serves some content gzip-compressed regardless of the request headers.
fn gunzip(body: &[u8]) -> Option<Vec<u8>> {
    use std::io::Read;
    let mut out = Vec::new();
    flate2::read::GzDecoder::new(body)
        .read_to_end(&mut out)
        .ok()?;
    Some(out)
}

fn is_summary_item(item: &Value) -> bool {
    item.get("data_id")
        .and_then(Value::as_str)
        .is_some_and(|id| id.starts_with("auto_sum:"))
        || item.get("data_type").and_then(Value::as_str) == Some("auto_sum_note")
}

fn parse_summary_body(body: &[u8]) -> Option<Value> {
    match serde_json::from_slice::<Value>(body) {
        Ok(v) if v.is_object() => Some(v),
        Ok(Value::String(s)) => {
            let trimmed = s.trim();
            (!trimmed.is_empty()).then(|| serde_json::json!({ "ai_content": trimmed }))
        }
        Ok(_) => None,
        Err(_) => {
            let text = std::str::from_utf8(body).ok()?.trim();
            (!text.is_empty()).then(|| serde_json::json!({ "ai_content": text }))
        }
    }
}

fn transcript_segments(body: &[u8]) -> Option<Vec<Value>> {
    let parsed: Value = serde_json::from_slice(body).ok()?;
    if let Some(arr) = parsed.as_array() {
        return Some(arr.clone());
    }
    parsed
        .get("trans_result")
        .or_else(|| parsed.get("segments"))
        .or_else(|| parsed.pointer("/data/trans_result"))
        .or_else(|| parsed.pointer("/data/segments"))
        .and_then(Value::as_array)
        .cloned()
}

fn speaker_number(v: &Value) -> Option<i64> {
    v.as_i64().or_else(|| v.as_str()?.parse().ok())
}

/// Each segment becomes a line, prefixed with `Speaker <n>:` when the speaker is a number.
fn transcript_text(body: &[u8]) -> Option<String> {
    let segments = transcript_segments(body)?;
    let lines: Vec<String> = segments
        .iter()
        .filter_map(|s| {
            let content = s
                .get("content")
                .or_else(|| s.get("text"))
                .and_then(Value::as_str)?
                .trim();
            if content.is_empty() {
                return None;
            }
            Some(match s.get("speaker").and_then(speaker_number) {
                Some(n) => format!("Speaker {n}: {content}"),
                None => content.to_owned(),
            })
        })
        .collect();
    (!lines.is_empty()).then(|| lines.join("\n"))
}

/// A segment time in milliseconds, as Plaud's other time fields are. Floats are rounded, not scaled.
/// Whole numbers are milliseconds; fractional values are seconds (as before this parser was
/// hardened; spec/plaud.md leaves the segment shape unverified).
fn segment_ms(v: &Value) -> Option<i64> {
    v.as_i64().or_else(|| {
        v.as_f64()
            .filter(|f| f.is_finite())
            .map(|f| (f * 1000.0).round() as i64)
    })
}

/// Timed lines for the timeline. A segment without text or a usable start is skipped, not fatal.
fn transcript_timeline(body: &[u8]) -> Option<Vec<Value>> {
    let segments = transcript_segments(body)?;
    let mut timeline = Vec::new();
    for s in &segments {
        let Some(content) = s
            .get("content")
            .or_else(|| s.get("text"))
            .and_then(Value::as_str)
            .map(str::trim)
        else {
            continue;
        };
        if content.is_empty() {
            continue;
        }
        let Some(start_ms) = s
            .get("start_time")
            .or_else(|| s.get("start_ms"))
            .or_else(|| s.get("start"))
            .and_then(segment_ms)
        else {
            continue;
        };
        let end_ms = s
            .get("end_time")
            .or_else(|| s.get("end_ms"))
            .or_else(|| s.get("end"))
            .and_then(segment_ms)
            .unwrap_or(start_ms);
        let speaker_id = s
            .get("speaker")
            .and_then(speaker_number)
            .map(|n| format!("Speaker {n}"));
        timeline.push(serde_json::json!({
            "start_ms": start_ms,
            "end_ms": end_ms,
            "text": content,
            "speaker_id": speaker_id,
            "timestamp_source": "native"
        }));
    }
    (!timeline.is_empty()).then_some(timeline)
}

fn first_str(v: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|k| v.get(*k).and_then(Value::as_str))
        .map(str::to_owned)
}

fn list_of(v: &Value, keys: &[&str]) -> Vec<Value> {
    keys.iter()
        .find_map(|k| v.get(*k).and_then(Value::as_array))
        .cloned()
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniffed_type_beats_the_label() {
        assert_eq!(sniff_ext(b"ID3\x04"), "mp3");
        assert_eq!(sniff_ext(b"OggS\0\0\0\0OpusHead"), "opus");
        assert_eq!(sniff_ext(b"OggS\0\0\0\0vorbis"), "ogg");
        assert_eq!(sniff_ext(b"\0\0\0\x18ftypM4A "), "m4a");
        assert_eq!(sniff_ext(b"fLaC"), "flac");
        assert_eq!(sniff_ext(b"????"), "mp3");
    }

    #[test]
    fn transcript_lines_carry_speakers() {
        let body = br#"[{"start_time":0,"end_time":1,"speaker":"2","content":"Hi"},{"speaker":"Ann","content":"Yo"}]"#;
        assert_eq!(transcript_text(body).as_deref(), Some("Speaker 2: Hi\nYo"));
        assert_eq!(transcript_text(b"[]"), None);
    }

    #[test]
    fn timeline_skips_bad_segments_and_reads_ms_ints_and_second_floats() {
        let body = br#"[
            {"start_time":1500,"end_time":2000,"speaker":1,"content":"One"},
            {"start_time":2.0004,"end_time":2.6006,"speaker":"2","content":"Two"},
            {"start_time":3000,"end_time":3500},
            {"start_time":"soon","content":"Three"},
            {"start_time":4000,"end_time":4500,"speaker":"Ann","content":"Four"}
        ]"#;
        let timeline = transcript_timeline(body).unwrap();
        assert_eq!(timeline.len(), 3);
        assert_eq!(timeline[0]["start_ms"], 1500);
        assert_eq!(timeline[1]["start_ms"], 2000);
        assert_eq!(timeline[1]["end_ms"], 2601);
        assert_eq!(timeline[1]["speaker_id"], "Speaker 2");
        assert_eq!(timeline[2]["text"], "Four");
        assert!(timeline[2]["speaker_id"].is_null());
        assert_eq!(transcript_timeline(b"[{\"content\":\"no time\"}]"), None);
    }

    #[test]
    fn gunzip_reads_plaud_content() {
        use std::io::Write;
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(br#"[{"content":"hi","speaker":1}]"#).unwrap();
        let body = super::gunzip(&enc.finish().unwrap()).unwrap();
        assert_eq!(
            super::transcript_text(&body).as_deref(),
            Some("Speaker 1: hi")
        );
        assert!(super::gunzip(b"not gzip").is_none());
    }

    #[test]
    fn summary_parser_accepts_json_and_plain_markdown() {
        let json_val = parse_summary_body(br#"{"ai_content":"Summary","key_points":["a"]}"#)
            .expect("json summary");
        assert_eq!(json_val["ai_content"], "Summary");

        let md_val =
            parse_summary_body(b"# Summary\nFake v4 markdown summary\n").expect("markdown summary");
        assert_eq!(md_val["ai_content"], "# Summary\nFake v4 markdown summary");

        assert!(parse_summary_body(b"   \n\t ").is_none());
        assert!(parse_summary_body(b"null").is_none());
        assert!(parse_summary_body(b"[]").is_none());
    }

    #[test]
    fn summary_matcher_accepts_prefix_and_data_type() {
        assert!(is_summary_item(
            &serde_json::json!({ "data_id": "auto_sum:1" })
        ));
        assert!(is_summary_item(
            &serde_json::json!({ "data_id": "other", "data_type": "auto_sum_note" })
        ));
        assert!(!is_summary_item(
            &serde_json::json!({ "data_id": "source_transaction:1", "data_type": "transaction" })
        ));
    }

    #[test]
    fn transcript_unwraps_trans_result_and_segments_objects() {
        let wrapped_tr =
            br#"{"trans_result":[{"start_time":100,"end_time":500,"speaker":1,"content":"Hello"}]}"#;
        assert_eq!(
            transcript_text(wrapped_tr).as_deref(),
            Some("Speaker 1: Hello")
        );
        let tl = transcript_timeline(wrapped_tr).unwrap();
        assert_eq!(tl.len(), 1);
        assert_eq!(tl[0]["start_ms"], 100);

        let wrapped_seg = br#"{"segments":[{"start_ms":200,"end_ms":400,"text":"World"}]}"#;
        assert_eq!(transcript_text(wrapped_seg).as_deref(), Some("World"));
        let tl2 = transcript_timeline(wrapped_seg).unwrap();
        assert_eq!(tl2.len(), 1);
        assert_eq!(tl2[0]["start_ms"], 200);
    }

    #[test]
    fn stitch_part_transcripts_offsets_timelines_by_prior_audio_duration() {
        let p0 = PartTranscript {
            text: "Part one".into(),
            timeline: Some(vec![json!({
                "start_ms": 100,
                "end_ms": 900,
                "text": "Part one",
                "speaker_id": "Speaker 1",
                "timestamp_source": "native"
            })]),
            audio_duration_ms: 18_000_000,
        };
        let p1 = PartTranscript {
            text: "Part two".into(),
            timeline: Some(vec![json!({
                "start_ms": 500,
                "end_ms": 1500,
                "text": "Part two",
                "speaker_id": "Speaker 1",
                "timestamp_source": "native"
            })]),
            audio_duration_ms: 7_200_000,
        };
        let (text, timeline) = stitch_part_transcripts(&[p0, p1]).unwrap();
        assert_eq!(text, "Part one\n\nPart two");
        let tl = timeline.unwrap();
        assert_eq!(tl.len(), 2);
        assert_eq!(tl[0]["start_ms"], 100);
        assert_eq!(tl[0]["end_ms"], 900);
        assert_eq!(tl[1]["start_ms"], 18_000_500);
        assert_eq!(tl[1]["end_ms"], 18_001_500);
    }

    #[test]
    fn stitch_part_summaries_joins_text_and_lists() {
        let a = parse_summary_fields(&json!({
            "ai_content": "First half",
            "key_points": ["k1"],
            "action_items": ["a1"]
        }));
        let b = parse_summary_fields(&json!({
            "summary": "Second half",
            "keyPoints": ["k2"],
            "todos": ["a2"]
        }));
        let stitched = stitch_part_summaries(&[a, b]);
        assert_eq!(stitched.text, "First half\n\nSecond half");
        assert_eq!(stitched.key_points, vec![json!("k1"), json!("k2")]);
        assert_eq!(stitched.action_items, vec![json!("a1"), json!("a2")]);
    }
}
