//! Audio download and storage, and Plaud's own transcript and summary import.

use std::path::Path;

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::api::{self, Client};
use super::sync::ItemError;
use crate::{AppState, ids};

/// Where a downloaded recording's audio went: the backend it was written to and its object key.
pub struct Stored {
    pub storage_type: &'static str,
    pub key: String,
    pub peaks: Option<Vec<f64>>,
}

/// Downloads a recording's original audio to the active storage backend and returns where it went.
/// The bytes go to a temporary file, are fsynced, and only then get their final name.
pub async fn store_audio(
    state: &AppState,
    user_id: &str,
    client: &Client,
    file_id: &str,
) -> Result<Stored, ItemError> {
    let url = client.audio_url(file_id).await?;
    let mut resp = api::fetch(&url).await?;
    let dir = state.config.storage_root.join(user_id);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|_| ItemError::Failed("could not create the storage folder".into()))?;
    let temp = dir.join(format!(".plaud-{}.partial", ids::token_hex(8)));
    if let Err(e) = write_stream(&mut resp, &temp).await {
        let _ = tokio::fs::remove_file(&temp).await;
        return Err(e);
    }
    match stage_downloaded(state, user_id, file_id, &temp).await {
        Ok(stored) => Ok(stored),
        Err(e) => {
            // Every failure after the download leaves no temporary file behind.
            let _ = tokio::fs::remove_file(&temp).await;
            Err(e)
        }
    }
}

/// Names the finished download after its bytes and moves it into storage.
async fn stage_downloaded(
    state: &AppState,
    user_id: &str,
    file_id: &str,
    temp: &Path,
) -> Result<Stored, ItemError> {
    let head = read_head(temp).await?;
    let ext = sniff_ext(&head);
    let key = free_key(state, user_id, file_id, ext).await?;
    let mime = crate::routes::recordings::mime_for(ext);
    let peaks =
        crate::routes::recordings::media::compute_peaks(&state.config.ffmpeg, temp, 256).await;
    state
        .storage
        .store_staged(&key, temp, Some(mime))
        .await
        .map_err(|e| ItemError::Failed(format!("could not store the audio: {e}")))?;
    Ok(Stored {
        storage_type: state.storage.active_type(),
        key,
        peaks,
    })
}

async fn write_stream(resp: &mut reqwest::Response, path: &Path) -> Result<(), ItemError> {
    let mut file = tokio::fs::File::create(path)
        .await
        .map_err(|_| ItemError::Failed("could not write the audio".into()))?;
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|_| ItemError::Failed("the download was interrupted".into()))?
    {
        file.write_all(&chunk)
            .await
            .map_err(|_| ItemError::Failed("could not write the audio".into()))?;
    }
    file.flush()
        .await
        .map_err(|_| ItemError::Failed("could not write the audio".into()))?;
    file.sync_all()
        .await
        .map_err(|_| ItemError::Failed("could not write the audio".into()))?;
    Ok(())
}

async fn read_head(path: &Path) -> Result<Vec<u8>, ItemError> {
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
async fn free_key(
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

    if !has_transcript {
        let is_transcript = |item: &Value| {
            item.get("data_id")
                .and_then(Value::as_str)
                .is_some_and(|id| id.starts_with("source_transaction:"))
                || item.get("data_type").and_then(Value::as_str) == Some("transaction")
        };
        if let Some(link) = ready_link(&items, is_transcript) {
            let body = fetch_body(&link).await?;
            if let Some(text) = transcript_text(&body) {
                let timeline = transcript_timeline(&body);
                let (tl_val, tl_src) = match timeline {
                    Some(ref tl) => (
                        Some(
                            state
                                .config
                                .field_key
                                .encrypt_json(&Value::Array(tl.clone()))
                                .to_string(),
                        ),
                        Some("native"),
                    ),
                    None => (None, None),
                };
                let transcript_id = ids::new_id();
                // The transcript and the work it owes commit together, so a process that stops
                // between them cannot leave a transcript whose follow-up was never recorded: such
                // a transcript would look imported on the next pass and never be queued again.
                let mut tx = crate::db::begin_write(&state.db).await?;
                let inserted = sqlx::query(
                    "INSERT INTO transcriptions (id, recording_id, user_id, text, detected_language, transcription_type, provider, model, timeline, timeline_source, source, created_at) \
                     VALUES (?, ?, ?, ?, NULL, 'server', 'plaud', 'plaud-native', ?, ?, 'plaud', ?) ON CONFLICT DO NOTHING",
                )
                .bind(&transcript_id)
                .bind(recording_id)
                .bind(user_id)
                .bind(state.config.field_key.encrypt(&text))
                .bind(tl_val)
                .bind(tl_src)
                .bind(now)
                .execute(&mut *tx)
                .await?;
                if inserted.rows_affected() == 1 {
                    // Plaud's own transcript does not emit `transcription.completed` and does not
                    // generate a title; the source in the payload decides that. It does owe the
                    // automatic summary, which the follow-up queues.
                    crate::summary::followup::enqueue_in(
                        &mut *tx,
                        user_id,
                        recording_id,
                        &transcript_id,
                        "plaud",
                    )
                    .await?;
                    tx.commit().await?;
                    imported = true;
                    transcript_added = true;
                } else {
                    tx.rollback().await?;
                }
            }
        }
    }

    if !has_summary {
        let is_summary = |item: &Value| {
            item.get("data_id")
                .and_then(Value::as_str)
                .is_some_and(|id| id.starts_with("auto_sum:"))
        };
        let inline = detail
            .get("pre_download_content_list")
            .and_then(Value::as_array)
            .and_then(|list| list.iter().find(|i| is_summary(i)))
            .and_then(|i| i.get("data_content"))
            .and_then(Value::as_str)
            .and_then(|s| serde_json::from_str::<Value>(s).ok());
        let summary = match inline {
            Some(v) => Some(v),
            None => match ready_link(&items, is_summary) {
                Some(link) => serde_json::from_slice::<Value>(&fetch_body(&link).await?).ok(),
                None => None,
            },
        };
        if let Some(v) = summary {
            let text = first_str(&v, &["ai_content", "summary", "content"]).unwrap_or_default();
            let key_points = list_of(&v, &["key_points", "keyPoints", "highlights"]);
            let action_items = list_of(&v, &["action_items", "actionItems", "todos"]);
            if !text.is_empty() || !key_points.is_empty() || !action_items.is_empty() {
                let key = &state.config.field_key;
                sqlx::query(
                    "INSERT INTO ai_enhancements (id, recording_id, user_id, summary, action_items, key_points, provider, model, source, prompt_id, language, created_at, has_content) \
                     VALUES (?, ?, ?, ?, ?, ?, 'plaud', 'plaud-native', 'plaud', NULL, NULL, ?, 1) ON CONFLICT (recording_id, user_id) DO NOTHING",
                )
                .bind(ids::new_id())
                .bind(recording_id)
                .bind(user_id)
                .bind((!text.is_empty()).then(|| key.encrypt(&text)))
                .bind(key.encrypt_json(&Value::Array(action_items)).to_string())
                .bind(key.encrypt_json(&Value::Array(key_points)).to_string())
                .bind(now)
                .execute(&state.db)
                .await?;
                imported = true;
            }
        }
    }
    // Plaud's transcript arrives outside the transcription job, so the summary step runs from
    // the follow-up job the import queued above.
    if transcript_added {
        crate::summary::followup::notify(state);
    }
    Ok(imported)
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

fn speaker_number(v: &Value) -> Option<i64> {
    v.as_i64().or_else(|| v.as_str()?.parse().ok())
}

/// Each segment becomes a line, prefixed with `Speaker <n>:` when the speaker is a number.
fn transcript_text(body: &[u8]) -> Option<String> {
    let segments: Vec<Value> = serde_json::from_slice(body).ok()?;
    let lines: Vec<String> = segments
        .iter()
        .filter_map(|s| {
            let content = s.get("content")?.as_str()?.trim();
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
    let segments: Vec<Value> = serde_json::from_slice(body).ok()?;
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
}
