//! Sends one audio file to a provider and parses the answer (spec/transcription.md:
//! whisper style, diarized output, chat style, and size handling).

use std::path::{Path, PathBuf};
use std::time::Duration;

use axum::body::Bytes;
use reqwest::multipart::{Form, Part};
use serde_json::{Value, json};
use tokio::process::Command;

use super::diarize::{self, Speakers};
use super::{Options, Segment, Transcript};
use crate::AppState;
use crate::ai::{self, AiError, ChatOptions, Provider};
use crate::config;
use crate::ids;
use crate::routes::recordings::media;

/// Hard upload limit of the whisper style: 25 MiB.
const MAX_UPLOAD_BYTES: u64 = 26_214_400;
const DEFAULT_MAX_BYTES: u64 = 25_165_824;
const MIN_BITRATE_KBPS: u64 = 6;
/// Longest part sent to a diarizing model, in seconds.
const PART_SECONDS: f64 = 1199.0;
const CHAT_BUDGET: u32 = 16_384;
const GEMINI_MAX_BYTES: u64 = 20 * 1024 * 1024;
const ELEVEN_MAX_BYTES: u64 = 128 * 1024 * 1024;
const ELEVEN_MAX_RESPONSE: usize = 32 * 1024 * 1024;

/// Sends one audio file to the provider and parses the answer.
pub async fn transcribe_file(
    state: &AppState,
    provider: &Provider,
    path: &Path,
    options: &Options,
) -> Result<Transcript, AiError> {
    let timeout = Duration::from_millis(
        config::number("WHISPER_REQUEST_TIMEOUT_MS", 3_600_000, 1, u64::MAX).unwrap_or(3_600_000),
    );
    let work = Workdir::new(state)
        .await
        .map_err(|_| failed("Could not create a work folder."))?;
    if provider.name == "Google Gemini" {
        gemini_style(provider, path, options, timeout).await
    } else if provider.name == "ElevenLabs" {
        eleven_style(provider, path, options, timeout).await
    } else if provider.preset().is_some_and(|p| p.chat_transcription) {
        chat_style(state, provider, path, options, timeout, &work).await
    } else if options.model.contains("diarize") {
        diarized_style(state, provider, path, options, timeout, &work).await
    } else {
        whisper_style(provider, path, options, timeout, &work, state).await
    }
}

async fn gemini_style(
    provider: &Provider,
    path: &Path,
    options: &Options,
    timeout: Duration,
) -> Result<Transcript, AiError> {
    let size = file_size(path).await?;
    if size > GEMINI_MAX_BYTES {
        return Err(failed("Audio over 20 MB cannot be sent to Google Gemini."));
    }
    let mime = match mime_for(path) {
        "application/octet-stream" => {
            return Err(failed("Google Gemini does not support this audio type."));
        }
        "audio/mpeg" => "audio/mp3",
        m => m,
    };
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|_| failed("Could not read the audio file."))?;
    let mut prompt =
        String::from("Transcribe the attached audio verbatim. Output only the transcript text.");
    if let Some(language) = &options.language {
        prompt.push_str(&format!(" The audio language is {language}."));
    }
    let body = json!({"contents":[{"parts":[{"text":prompt},{"inlineData":{"mimeType":mime,"data":base64(&bytes)}}]}]});
    let model = if options.model.is_empty() {
        "gemini-2.0-flash"
    } else {
        &options.model
    };
    let endpoint =
        format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent");
    let res = ai::client()
        .post(endpoint)
        .header("x-goog-api-key", &provider.api_key)
        .timeout(timeout)
        .json(&body)
        .send()
        .await
        .map_err(ai::upstream_error)?;
    if !res.status().is_success() {
        return Err(ai::status_error(res.status()));
    }
    let value: Value = res.json().await.map_err(ai::upstream_error)?;
    let text = value["candidates"][0]["content"]["parts"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|part| part["text"].as_str())
        .collect::<Vec<_>>()
        .join("")
        .trim()
        .to_owned();
    if text.is_empty() {
        return Err(AiError {
            code: "AI_EMPTY_RESPONSE",
            message: "The provider returned an empty answer.".into(),
            retryable: false,
        });
    }
    Ok(Transcript {
        text,
        language: options.language.clone(),
        segments: Vec::new(),
    })
}

async fn eleven_style(
    provider: &Provider,
    path: &Path,
    options: &Options,
    timeout: Duration,
) -> Result<Transcript, AiError> {
    let size = file_size(path).await?;
    if size > ELEVEN_MAX_BYTES {
        return Err(AiError {
            code: "FILE_TOO_LARGE",
            message: "The audio file exceeds ElevenLabs' 128 MB limit.".into(),
            retryable: false,
        });
    }
    let language = options
        .language
        .as_deref()
        .map(normalize_language)
        .transpose()?;
    let speaker_count = if options.diarize {
        options.speaker_count
    } else {
        None
    };
    if speaker_count.is_some_and(|n| !(1..=32).contains(&n)) {
        return Err(failed("Speaker count must be between 1 and 32."));
    }
    // Shared buffer: each attempt clones the handle, not the audio.
    let bytes: Bytes = tokio::fs::read(path)
        .await
        .map(Bytes::from)
        .map_err(|_| failed("Could not read the audio file."))?;
    let filename = upload_name(&options.filename, path);
    let mut attempt = 0;
    loop {
        let mut form = Form::new()
            .part(
                "file",
                Part::stream_with_length(reqwest::Body::from(bytes.clone()), bytes.len() as u64)
                    .file_name(filename.clone())
                    .mime_str(mime_for(path))
                    .map_err(|_| failed("Could not prepare the audio file."))?,
            )
            .text(
                "model_id",
                if options.model.is_empty() {
                    "scribe_v2".into()
                } else {
                    options.model.clone()
                },
            )
            .text("timestamps_granularity", "word")
            .text("tag_audio_events", "false")
            .text("diarize", options.diarize.to_string());
        if let Some(language) = &language {
            form = form.text("language_code", language.clone());
        }
        if let Some(n) = speaker_count {
            form = form.text("num_speakers", n.to_string());
        }
        let response = ai::client()
            .post(format!("{}/speech-to-text", provider.base_url))
            .header("xi-api-key", &provider.api_key)
            .timeout(timeout)
            .multipart(form)
            .send()
            .await;
        let response = match response {
            Ok(r) if r.status().is_success() => r,
            Ok(r)
                if attempt < 2
                    && matches!(r.status().as_u16(), 429 | 500 | 502 | 503 | 504 | 524) =>
            {
                attempt += 1;
                tokio::time::sleep(Duration::from_secs(1 << (attempt - 1))).await;
                continue;
            }
            Ok(r) => return Err(ai::status_error(r.status())),
            Err(_) if attempt < 2 => {
                attempt += 1;
                tokio::time::sleep(Duration::from_secs(1 << (attempt - 1))).await;
                continue;
            }
            Err(e) => return Err(ai::upstream_error(e)),
        };
        if response
            .content_length()
            .is_some_and(|n| n > ELEVEN_MAX_RESPONSE as u64)
        {
            return Err(failed("ElevenLabs returned a response that was too large."));
        }
        let mut response = response;
        let mut raw = Vec::new();
        loop {
            let chunk = response.chunk().await.map_err(ai::upstream_error)?;
            let Some(chunk) = chunk else {
                break;
            };
            if raw.len().saturating_add(chunk.len()) > ELEVEN_MAX_RESPONSE {
                return Err(failed("ElevenLabs returned a response that was too large."));
            }
            raw.extend_from_slice(&chunk);
        }
        let value: Value = serde_json::from_slice(&raw)
            .map_err(|_| failed("ElevenLabs returned an unreadable reply."))?;
        let (text, segments) = eleven_transcript(&value, options.diarize);
        if text.trim().is_empty() {
            return Err(AiError {
                code: "AI_EMPTY_RESPONSE",
                message: "The provider returned an empty answer.".into(),
                retryable: false,
            });
        }
        let detected = value["language_code"]
            .as_str()
            .and_then(|s| normalize_language(s).ok());
        return Ok(Transcript {
            text,
            language: detected,
            segments,
        });
    }
}

fn normalize_language(value: &str) -> Result<String, AiError> {
    let valid = value
        .split('-')
        .all(|p| !p.is_empty() && p.len() <= 8 && p.chars().all(|c| c.is_ascii_alphanumeric()))
        && matches!(value.split('-').next().unwrap_or_default().len(), 2 | 3);
    if valid {
        Ok(value.to_ascii_lowercase())
    } else {
        Err(failed(
            "Language must be a valid two- or three-letter language code.",
        ))
    }
}

/// A word's start, end and text. None when any of them is missing or of the wrong type.
fn timed_word(word: &Value) -> Option<(f64, f64, &str)> {
    Some((
        word["start"].as_f64()?,
        word["end"].as_f64()?,
        word["text"].as_str()?,
    ))
}

/// Speaker label for words that have no speaker and no earlier segment to join.
const UNKNOWN_SPEAKER: &str = "Unknown speaker";

fn eleven_transcript(value: &Value, diarize: bool) -> (String, Vec<Segment>) {
    let words = value["words"].as_array().cloned().unwrap_or_default();
    let timed: Vec<Segment> = words
        .iter()
        .filter_map(|w| {
            let (start, end, text) = timed_word(w)?;
            let speaker = w["speaker_id"].as_str().map(str::to_owned);
            Some(Segment {
                start,
                end,
                text: text.to_owned(),
                speaker,
            })
        })
        .collect();
    if diarize && !timed.is_empty() {
        let mut labels = Speakers::default();
        let mut out = Vec::<Segment>::new();
        // Each word is read on its own, so a malformed word cannot shift the words after it.
        for word in &words {
            let Some((start, end, token)) = timed_word(word) else {
                continue;
            };
            let label = match word["speaker_id"].as_str() {
                Some(raw) => labels.label(raw),
                // A word without a speaker continues the speaker before it.
                None => out
                    .last()
                    .and_then(|last| last.speaker.clone())
                    .unwrap_or_else(|| UNKNOWN_SPEAKER.to_owned()),
            };
            if let Some(last) = out
                .last_mut()
                .filter(|last| last.speaker.as_deref() == Some(label.as_str()))
            {
                last.text.push_str(token);
                last.end = end;
            } else {
                out.push(Segment {
                    start,
                    end,
                    text: token.to_owned(),
                    speaker: Some(label),
                });
            }
        }
        let text = out
            .iter()
            .map(|s| {
                format!(
                    "{}: {}",
                    s.speaker.as_deref().unwrap_or("Speaker"),
                    s.text.trim()
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        return (text, out);
    }
    (
        value["text"].as_str().unwrap_or_default().trim().to_owned(),
        timed,
    )
}

fn failed(message: &str) -> AiError {
    AiError {
        code: "TRANSCRIPTION_FAILED",
        message: message.to_owned(),
        retryable: false,
    }
}

/// Scratch folder for converted audio. Removed when dropped.
struct Workdir(PathBuf);

impl Workdir {
    async fn new(state: &AppState) -> std::io::Result<Self> {
        let dir = state
            .config
            .storage_root
            .join(".transcribe")
            .join(ids::new_id());
        tokio::fs::create_dir_all(&dir).await?;
        Ok(Self(dir))
    }

    fn file(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for Workdir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

async fn whisper_style(
    provider: &Provider,
    path: &Path,
    options: &Options,
    timeout: Duration,
    work: &Workdir,
    state: &AppState,
) -> Result<Transcript, AiError> {
    let (upload, mime) = upload_copy(state, path, work).await?;
    let format = if options.model.starts_with("gpt-4o") {
        "json"
    } else {
        "verbose_json"
    };
    let mut fields = vec![
        ("model", options.model.clone()),
        ("response_format", format.to_owned()),
    ];
    if let Some(language) = &options.language {
        fields.push(("language", language.clone()));
    }
    let name = upload_name(&options.filename, &upload);
    let reply = post_form(
        provider,
        "/audio/transcriptions",
        file_form(&upload, &name, mime, fields).await?,
        timeout,
    )
    .await?;
    Ok(whisper_transcript(&reply, format == "verbose_json"))
}

/// Reads a whisper style answer. Timings come from `segments`, which only verbose_json carries.
fn whisper_transcript(reply: &Value, verbose: bool) -> Transcript {
    Transcript {
        text: reply["text"].as_str().unwrap_or_default().trim().to_owned(),
        language: if verbose {
            reply["language"].as_str().map(str::to_owned)
        } else {
            None
        },
        segments: if verbose {
            raw_segments(reply)
        } else {
            Vec::new()
        },
    }
}

/// The file to upload: the original when it fits, else a mono Opus copy at the highest bitrate that fits.
async fn upload_copy(
    state: &AppState,
    path: &Path,
    work: &Workdir,
) -> Result<(PathBuf, &'static str), AiError> {
    let limit = config::number("WHISPER_MAX_BYTES", DEFAULT_MAX_BYTES, 1, MAX_UPLOAD_BYTES)
        .unwrap_or(DEFAULT_MAX_BYTES);
    if file_size(path).await? <= limit {
        return Ok((path.to_path_buf(), mime_for(path)));
    }
    let mut kbps = config::number("WHISPER_COMPRESS_BITRATE_KBPS", 12, 1, u64::MAX).unwrap_or(12);
    loop {
        let out = work.file(&format!("upload-{kbps}k.ogg"));
        if !to_opus(state, path, &out, kbps).await {
            return Err(failed("Could not re-encode the audio for upload."));
        }
        if file_size(&out).await? <= MAX_UPLOAD_BYTES {
            return Ok((out, "audio/ogg"));
        }
        if kbps <= MIN_BITRATE_KBPS {
            return Err(failed(
                "The audio is too large to upload, even at the lowest bitrate.",
            ));
        }
        kbps = (kbps / 2).max(MIN_BITRATE_KBPS);
    }
}

async fn diarized_style(
    state: &AppState,
    provider: &Provider,
    path: &Path,
    options: &Options,
    timeout: Duration,
    work: &Workdir,
) -> Result<Transcript, AiError> {
    let mp3 = work.file("audio.mp3");
    if !media::to_mp3(&state.config.ffmpeg, path, &mp3).await {
        return Err(failed("Could not convert the audio to mp3."));
    }
    let total = media::probe(&state.config.ffprobe, &mp3)
        .await
        .map_or(0.0, |p| p.duration_ms as f64 / 1000.0);
    let split = split_points(total);
    let title = options.filename.trim().to_owned();
    let title = if title.is_empty() {
        "audio".to_owned()
    } else {
        title
    };
    let mut speakers = Speakers::default();
    let mut rendered = Vec::new();
    let mut all = Vec::new();
    for (i, (start, len)) in split.iter().copied().enumerate() {
        let (file, name) = if split.len() == 1 {
            (mp3.clone(), format!("{title}.mp3"))
        } else {
            let name = format!("{title}-part-{}.mp3", i + 1);
            let part = work.file(&name);
            if !cut(state, &mp3, &part, start, len).await {
                return Err(failed("Could not split the audio for diarization."));
            }
            (part, name)
        };
        let mut fields = vec![
            ("model", options.model.clone()),
            ("response_format", "diarized_json".to_owned()),
            ("chunking_strategy", "auto".to_owned()),
        ];
        if let Some(language) = &options.language {
            fields.push(("language", language.clone()));
        }
        let reply = post_form(
            provider,
            "/audio/transcriptions",
            file_form(&file, &name, "audio/mpeg", fields).await?,
            timeout,
        )
        .await?;
        let turns = diarize::turns(&raw_segments(&reply), start, &mut speakers);
        let text = diarize::render(&turns, i + 1);
        if !text.is_empty() {
            rendered.push(text);
        }
        all.extend(turns);
    }
    Ok(Transcript {
        text: rendered.join("\n\n"),
        language: None,
        segments: all,
    })
}

/// Equal parts of at most `PART_SECONDS`, as (start, length) in seconds. One part when short or unknown.
fn split_points(total: f64) -> Vec<(f64, f64)> {
    let n = (total / PART_SECONDS).ceil().max(1.0) as usize;
    let len = total / n as f64;
    (0..n).map(|i| (i as f64 * len, len)).collect()
}

fn raw_segments(reply: &Value) -> Vec<Segment> {
    reply["segments"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|s| Segment {
                    start: s["start"].as_f64().unwrap_or(0.0),
                    end: s["end"].as_f64().unwrap_or(0.0),
                    text: s["text"].as_str().unwrap_or_default().to_owned(),
                    speaker: s["speaker"].as_str().map(str::to_owned),
                })
                .collect()
        })
        .unwrap_or_default()
}

async fn chat_style(
    state: &AppState,
    provider: &Provider,
    path: &Path,
    options: &Options,
    timeout: Duration,
    work: &Workdir,
) -> Result<Transcript, AiError> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let (audio, format) = if ext == "mp3" || ext == "wav" {
        (path.to_path_buf(), ext)
    } else {
        let mp3 = work.file("chat-audio.mp3");
        if !media::to_mp3(&state.config.ffmpeg, path, &mp3).await {
            return Err(failed(
                "This provider needs mp3 or wav audio, and the recording could not be converted to mp3.",
            ));
        }
        (mp3, "mp3".to_owned())
    };
    let bytes = tokio::fs::read(&audio)
        .await
        .map_err(|_| failed("Could not read the audio file."))?;
    let mut prompt =
        String::from("Transcribe the attached audio verbatim. Output only the transcript text.");
    if let Some(language) = &options.language {
        prompt.push_str(&format!(" The audio language is {language}."));
    }
    let messages = json!([{
        "role": "user",
        "content": [
            { "type": "text", "text": prompt },
            { "type": "input_audio", "input_audio": { "data": base64(&bytes), "format": format } }
        ]
    }]);
    let mut chat_provider = provider.clone();
    chat_provider.model = Some(options.model.clone());
    let text = ai::chat(
        &chat_provider,
        messages,
        &ChatOptions {
            temperature: 0.0,
            budget: CHAT_BUDGET,
            timeout,
        },
    )
    .await?;
    Ok(Transcript {
        text,
        language: options.language.clone(),
        segments: Vec::new(),
    })
}

async fn post_form(
    provider: &Provider,
    path: &str,
    form: Form,
    timeout: Duration,
) -> Result<Value, AiError> {
    let res = ai::client()
        .post(format!("{}{path}", provider.base_url))
        .bearer_auth(&provider.api_key)
        .timeout(timeout)
        .multipart(form)
        .send()
        .await
        .map_err(ai::upstream_error)?;
    if !res.status().is_success() {
        return Err(ai::status_error(res.status()));
    }
    res.json::<Value>().await.map_err(ai::upstream_error)
}

/// The upload name: the recording title with the extension of the file actually sent.
fn upload_name(title: &str, upload: &Path) -> String {
    let ext = upload.extension().and_then(|e| e.to_str()).unwrap_or("bin");
    let title = title.trim();
    if title.is_empty() {
        format!("audio.{ext}")
    } else {
        format!("{title}.{ext}")
    }
}

async fn file_form(
    path: &Path,
    name: &str,
    mime: &str,
    fields: Vec<(&'static str, String)>,
) -> Result<Form, AiError> {
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|_| failed("Could not read the audio file."))?;
    let file = Part::bytes(bytes)
        .file_name(name.to_owned())
        .mime_str(mime)
        .map_err(|_| failed("Could not prepare the audio file."))?;
    Ok(fields
        .into_iter()
        .fold(Form::new().part("file", file), |form, (name, value)| {
            form.text(name, value)
        }))
}

async fn file_size(path: &Path) -> Result<u64, AiError> {
    tokio::fs::metadata(path)
        .await
        .map(|m| m.len())
        .map_err(|_| failed("Could not read the audio file."))
}

fn mime_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        Some("m4a" | "mp4") => "audio/mp4",
        Some("ogg" | "opus") => "audio/ogg",
        Some("webm") => "audio/webm",
        Some("flac") => "audio/flac",
        Some("aac") => "audio/aac",
        _ => "application/octet-stream",
    }
}

async fn to_opus(state: &AppState, src: &Path, dst: &Path, kbps: u64) -> bool {
    let mut cmd = Command::new(&state.config.ffmpeg);
    cmd.args(["-v", "error", "-i"])
        .arg(src)
        .args(["-map", "0:a:0", "-ac", "1", "-c:a", "libopus", "-b:a"])
        .arg(format!("{kbps}k"))
        .args(["-f", "ogg"])
        .arg(dst);
    media::run(&mut cmd).await
}

async fn cut(state: &AppState, src: &Path, dst: &Path, start: f64, len: f64) -> bool {
    let mut cmd = Command::new(&state.config.ffmpeg);
    cmd.args(["-v", "error", "-i"])
        .arg(src)
        .args([
            "-ss",
            &format!("{start:.3}"),
            "-t",
            &format!("{len:.3}"),
            "-map",
            "0:a:0",
            "-c:a",
            "copy",
            "-f",
            "mp3",
        ])
        .arg(dst);
    media::run(&mut cmd).await
}

/// Standard base64 with padding, for the chat style's inline audio.
fn base64(data: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = u32::from(chunk[0]);
        let b1 = u32::from(chunk.get(1).copied().unwrap_or(0));
        let b2 = u32::from(chunk.get(2).copied().unwrap_or(0));
        let n = (b0 << 16) | (b1 << 8) | b2;
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Router,
        body::{Body, to_bytes},
        extract::Request,
        routing::post,
    };

    #[test]
    fn base64_matches_known_values() {
        assert_eq!(base64(b"Man"), "TWFu");
        assert_eq!(base64(b"Ma"), "TWE=");
        assert_eq!(base64(b"M"), "TQ==");
        assert_eq!(base64(b""), "");
    }

    #[test]
    fn split_points_cut_at_most_1199_seconds() {
        assert_eq!(split_points(0.0), vec![(0.0, 0.0)]);
        assert_eq!(split_points(1199.0), vec![(0.0, 1199.0)]);
        let parts = split_points(2398.0);
        assert_eq!(parts.len(), 2);
        assert!(parts.iter().all(|(_, len)| *len <= PART_SECONDS));
        assert_eq!(parts[1].0, 1199.0);
        let parts = split_points(3600.0);
        assert_eq!(parts.len(), 4);
        assert!((parts[3].0 + parts[3].1 - 3600.0).abs() < 1e-9);
    }

    #[test]
    fn verbose_json_keeps_segment_timings() {
        // Recorded shape of a whisper verbose_json answer.
        let reply = json!({
            "task": "transcribe",
            "language": "english",
            "duration": 3.0,
            "text": " Hello from the contract suite. This is a fixed transcript. ",
            "segments": [
                { "id": 0, "seek": 0, "start": 0.0, "end": 1.5, "text": " Hello from the contract suite.", "tokens": [50364], "temperature": 0.0, "avg_logprob": -0.2, "compression_ratio": 1.1, "no_speech_prob": 0.01 },
                { "id": 1, "seek": 150, "start": 1.5, "end": 3.0, "text": " This is a fixed transcript.", "tokens": [50500], "temperature": 0.0, "avg_logprob": -0.3, "compression_ratio": 1.0, "no_speech_prob": 0.02 }
            ]
        });
        let t = whisper_transcript(&reply, true);
        assert_eq!(
            t.text,
            "Hello from the contract suite. This is a fixed transcript."
        );
        assert_eq!(t.language.as_deref(), Some("english"));
        assert_eq!(
            t.segments,
            vec![
                Segment {
                    start: 0.0,
                    end: 1.5,
                    text: " Hello from the contract suite.".into(),
                    speaker: None
                },
                Segment {
                    start: 1.5,
                    end: 3.0,
                    text: " This is a fixed transcript.".into(),
                    speaker: None
                },
            ]
        );
        let plain = whisper_transcript(&reply, false);
        assert!(plain.segments.is_empty());
        assert!(plain.language.is_none());
    }

    #[test]
    fn mime_types_follow_extensions() {
        assert_eq!(mime_for(Path::new("a.M4A")), "audio/mp4");
        assert_eq!(mime_for(Path::new("a.unknown")), "application/octet-stream");
    }

    #[test]
    fn elevenlabs_diarization_preserves_word_spacing_and_times() {
        let value = json!({"text":"Hello there. Bye!","language_code":"en-US","words":[
            {"text":"Hello","start":0.1,"end":0.4,"speaker_id":"speaker_0"},
            {"text":" there.","start":0.4,"end":0.8,"speaker_id":"speaker_0"},
            {"text":" Bye!","start":1.0,"end":1.3,"speaker_id":"speaker_1"}
        ]});
        let (text, segments) = eleven_transcript(&value, true);
        assert_eq!(text, "Speaker 1: Hello there.\nSpeaker 2: Bye!");
        assert_eq!(segments[0].start, 0.1);
        assert_eq!(segments[0].end, 0.8);
        assert_eq!(segments[1].speaker.as_deref(), Some("Speaker 2"));
    }

    #[test]
    fn elevenlabs_uses_plain_text_when_diarization_is_off_and_validates_language() {
        let value = json!({"text":"  Plain transcript  ","words":[]});
        assert_eq!(eleven_transcript(&value, false).0, "Plain transcript");
        assert_eq!(normalize_language("zh-Hant-TW").unwrap(), "zh-hant-tw");
        assert!(normalize_language("x").is_err());
    }

    #[test]
    fn elevenlabs_diarization_keeps_later_words_aligned_past_bad_words() {
        // A word with no timing is dropped; a word with no speaker joins the speaker before it.
        let value = json!({"words":[
            {"text":"Okay","start":0.0,"end":0.2},
            {"text":"Hello","start":0.2,"end":0.5,"speaker_id":"speaker_0"},
            {"text":" dropped","end":0.6,"speaker_id":"speaker_0"},
            {"text":" there.","start":0.7,"end":1.0,"speaker_id":"speaker_1"},
            {"text":" Yes","start":1.1,"end":1.3},
            {"text":" Bye!","start":1.5,"end":1.8,"speaker_id":"speaker_0"}
        ]});
        let (text, segments) = eleven_transcript(&value, true);
        assert_eq!(
            text,
            "Unknown speaker: Okay\nSpeaker 1: Hello\nSpeaker 2: there. Yes\nSpeaker 1: Bye!"
        );
        assert_eq!(segments.len(), 4);
        assert_eq!(segments[2].speaker.as_deref(), Some("Speaker 2"));
        assert_eq!(segments[2].start, 0.7);
        assert_eq!(segments[2].end, 1.3);
        assert_eq!(segments[3].start, 1.5);
        assert_eq!(segments[3].speaker.as_deref(), Some("Speaker 1"));
    }

    #[tokio::test]
    #[allow(clippy::type_complexity)]
    async fn elevenlabs_local_http_contract_sends_key_fields_and_parses_timed_speakers() {
        use tokio::sync::oneshot;
        async fn receive(
            tx: axum::extract::State<
                std::sync::Arc<std::sync::Mutex<Option<oneshot::Sender<(String, String)>>>>,
            >,
            req: Request<Body>,
        ) -> axum::Json<Value> {
            let key = req
                .headers()
                .get("xi-api-key")
                .and_then(|h| h.to_str().ok())
                .unwrap_or_default()
                .to_owned();
            let body = to_bytes(req.into_body(), 1024 * 1024).await.unwrap();
            let _ = tx
                .lock()
                .unwrap()
                .take()
                .unwrap()
                .send((key, String::from_utf8_lossy(&body).into_owned()));
            axum::Json(json!({"text":"Hi there","language_code":"en","words":[
                {"text":"Hi","start":0.0,"end":0.2,"speaker_id":"spk_a"},
                {"text":" there","start":0.2,"end":0.5,"speaker_id":"spk_a"}
            ]}))
        }
        let (tx, rx) = oneshot::channel();
        let tx = std::sync::Arc::new(std::sync::Mutex::new(Some(tx)));
        let app = Router::new()
            .route("/v1/speech-to-text", post(receive))
            .with_state(tx);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("fixture.wav");
        tokio::fs::write(&path, b"safe test audio bytes")
            .await
            .unwrap();
        let provider = Provider {
            id: "p".into(),
            name: "ElevenLabs".into(),
            base_url: format!("http://{addr}/v1"),
            api_key: "fake-local-key".into(),
            model: Some("scribe_v2".into()),
        };
        let options = Options {
            filename: "Fixture".into(),
            model: "scribe_v2".into(),
            language: Some("en-US".into()),
            diarize: true,
            speaker_count: Some(2),
        };
        let transcript = eleven_style(&provider, &path, &options, Duration::from_secs(2))
            .await
            .unwrap();
        let (key, body) = rx.await.unwrap();
        assert_eq!(key, "fake-local-key");
        for field in [
            "model_id",
            "scribe_v2",
            "timestamps_granularity",
            "word",
            "tag_audio_events",
            "false",
            "diarize",
            "true",
            "language_code",
            "en-us",
            "num_speakers",
            "2",
        ] {
            assert!(
                body.contains(field),
                "missing multipart field/value {field}"
            );
        }
        assert_eq!(transcript.text, "Speaker 1: Hi there");
        assert_eq!(transcript.language.as_deref(), Some("en"));
        assert_eq!(transcript.segments[0].end, 0.5);
    }
}
