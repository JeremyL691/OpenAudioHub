//! `GET /api/export`: the user's recordings as json, txt, srt or vtt.

use std::collections::HashMap;

use axum::extract::{Query, State};
use axum::http::header;
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};

use super::{
    Summary, decrypt_summary, latest_transcripts, live_recordings, summaries, summary_json,
};
use crate::auth::CurrentUser;
use crate::db::now_ms;
use crate::error::{ApiResult, AppError};
use crate::routes::settings::effective;
use crate::{AppState, time};

const DAY_MS: i64 = 86_400_000;

/// One recording as an export sees it. Text is already decrypted.
pub(super) struct Item {
    pub id: String,
    pub filename: String,
    pub start: i64,
    pub duration: i64,
    pub filesize: i64,
    pub transcript: Option<String>,
    pub summary: Option<Summary>,
}

pub async fn get(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(query): Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    let format = match query.get("format").filter(|f| !f.is_empty()) {
        Some(f) => f.clone(),
        None => saved_format(&state, &user.id).await?,
    };
    let (content_type, ext) = match format.as_str() {
        "json" => ("application/json", "json"),
        "txt" => ("text/plain", "txt"),
        "srt" => ("text/plain", "srt"),
        "vtt" => ("text/vtt", "vtt"),
        _ => {
            return Err(
                AppError::bad_request("INVALID_INPUT", "Unknown export format")
                    .detail("field", "format"),
            );
        }
    };
    let items = items(&state, &user.id).await?;
    let body = match ext {
        "json" => serde_json::to_string_pretty(&json_items(&items)).map_err(AppError::internal)?,
        "txt" => txt(&items),
        "srt" => srt(&items),
        _ => vtt(&items),
    };
    let date = &time::iso(now_ms())[..10];
    let disposition = format!("attachment; filename=\"recordings-{date}.{ext}\"");
    Ok((
        [
            (header::CONTENT_TYPE, content_type.to_owned()),
            (header::CONTENT_DISPOSITION, disposition),
        ],
        body,
    )
        .into_response())
}

/// The saved `defaultExportFormat`, or `json` when it is not one of the four formats.
async fn saved_format(state: &AppState, user_id: &str) -> ApiResult<String> {
    let settings = effective(state, user_id).await?;
    let saved = settings
        .get("defaultExportFormat")
        .and_then(Value::as_str)
        .unwrap_or("json");
    Ok(match saved {
        "txt" | "srt" | "vtt" | "json" => saved.to_owned(),
        _ => "json".to_owned(),
    })
}

async fn items(state: &AppState, user_id: &str) -> ApiResult<Vec<Item>> {
    let rows = live_recordings(&state.db, user_id).await?;
    let transcripts = latest_transcripts(&state.db, user_id).await?;
    let summaries = summaries(&state.db, user_id).await?;
    let key = &state.config.field_key;
    rows.into_iter()
        .map(|r| {
            let transcript = transcripts
                .get(&r.id)
                .map(|t| key.decrypt(&t.text).map_err(AppError::internal))
                .transpose()?;
            let summary = summaries
                .get(&r.id)
                .map(|s| decrypt_summary(key, s))
                .transpose()?;
            Ok(Item {
                filename: key.decrypt(&r.filename).map_err(AppError::internal)?,
                id: r.id,
                start: r.start_time,
                duration: r.duration,
                filesize: r.filesize,
                transcript,
                summary,
            })
        })
        .collect()
}

/// JSON entries, newest recording first.
fn json_items(items: &[Item]) -> Value {
    let mut sorted: Vec<&Item> = items.iter().collect();
    sorted.sort_by_key(|i| std::cmp::Reverse(i.start));
    Value::Array(
        sorted
            .into_iter()
            .map(|i| {
                json!({
                    "id": i.id,
                    "filename": i.filename,
                    "duration": i.duration,
                    "startTime": time::iso(i.start),
                    "filesize": i.filesize,
                    "transcription": i.transcript,
                    "summary": i.summary.as_ref().map(summary_json),
                })
            })
            .collect(),
    )
}

fn txt(items: &[Item]) -> String {
    items
        .iter()
        .map(|i| {
            format!(
                "{}\n{}\n{}\n\n---\n\n",
                i.filename,
                time::iso(i.start),
                i.transcript.as_deref().unwrap_or("No transcription")
            )
        })
        .collect()
}

/// Clock time (UTC) of a Unix-millisecond instant, as `HH:MM:SS<sep>mmm`.
fn clock(ms: i64, sep: char) -> String {
    let t = ms.rem_euclid(DAY_MS);
    format!(
        "{:02}:{:02}:{:02}{sep}{:03}",
        t / 3_600_000,
        t / 60_000 % 60,
        t / 1000 % 60,
        t % 1000
    )
}

/// Transcribed recordings with their cue times: (start, end, text).
fn cues(items: &[Item]) -> impl Iterator<Item = (i64, i64, &str)> {
    items.iter().filter_map(|i| {
        i.transcript
            .as_deref()
            .map(|text| (i.start, i.start + i.duration, text))
    })
}

fn srt(items: &[Item]) -> String {
    cues(items)
        .enumerate()
        .map(|(n, (start, end, text))| {
            format!(
                "{}\n{} --> {}\n{text}\n\n",
                n + 1,
                clock(start, ','),
                clock(end, ',')
            )
        })
        .collect()
}

fn vtt(items: &[Item]) -> String {
    let mut out = String::from("WEBVTT\n\n");
    for (start, end, text) in cues(items) {
        out.push_str(&format!(
            "{} --> {}\n{text}\n\n",
            clock(start, '.'),
            clock(end, '.')
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(start: i64, duration: i64, transcript: Option<&str>) -> Item {
        Item {
            id: "rec".into(),
            filename: "Team sync".into(),
            start,
            duration,
            filesize: 1,
            transcript: transcript.map(str::to_owned),
            summary: None,
        }
    }

    #[test]
    fn clock_is_time_of_day_in_utc() {
        assert_eq!(clock(3_723_004, ','), "01:02:03,004");
        assert_eq!(clock(DAY_MS + 3_723_004, '.'), "01:02:03.004");
    }

    #[test]
    fn srt_numbers_only_transcribed_recordings() {
        let items = [
            item(0, 3000, None),
            item(5000, 2000, Some("hi")),
            item(9000, 1000, Some("bye")),
        ];
        assert_eq!(
            srt(&items),
            "1\n00:00:05,000 --> 00:00:07,000\nhi\n\n2\n00:00:09,000 --> 00:00:10,000\nbye\n\n"
        );
        assert_eq!(srt(&[item(0, 1, None)]), "");
    }

    #[test]
    fn vtt_has_header_and_timed_cues() {
        assert_eq!(vtt(&[]), "WEBVTT\n\n");
        assert_eq!(
            vtt(&[item(1500, 500, Some("x"))]),
            "WEBVTT\n\n00:00:01.500 --> 00:00:02.000\nx\n\n"
        );
    }

    #[test]
    fn txt_block_per_recording() {
        let out = txt(&[item(0, 1, None)]);
        assert_eq!(
            out,
            "Team sync\n1970-01-01T00:00:00.000Z\nNo transcription\n\n---\n\n"
        );
    }
}
