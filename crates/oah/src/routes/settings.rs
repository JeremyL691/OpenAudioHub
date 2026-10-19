//! User settings (`/api/settings/user`) and storage usage (`/api/settings/storage`).
//!
//! Settings are one JSON object per account. Only fields the user has set are stored;
//! defaults come from code and are merged in on read.

use axum::body::Bytes;
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{Map, Value, json};

use crate::AppState;
use crate::auth::{self, CurrentUser};
use crate::crypto::FieldKey;
use crate::db::now_ms;
use crate::error::{ApiResult, AppError};
use crate::notify::{self, SendError};
use crate::time::iso;

/// Language codes accepted for `aiOutputLanguage`.
/// shortcut: a short list of common codes, not the app's full list; align with the AI module.
const LANGUAGES: &[&str] = &[
    "en", "zh", "ja", "ko", "fr", "de", "es", "it", "pt", "ru", "ar", "hi", "nl", "sv", "pl", "tr",
    "vi", "th", "id",
];

enum Rule {
    Bool,
    Number,
    NumberOrNull,
    Any,
    OneOf(&'static [&'static str]),
    StringOrNull,
    ObjectOrNull,
    /// Integer 1 to 32, or null.
    Speakers,
    /// A code from `LANGUAGES`, or null. Stored lowercase.
    Language,
}

/// Every stored field except the encrypted prompts (handled in `apply`).
const RULES: &[(&str, Rule)] = &[
    ("autoTranscribe", Rule::Bool),
    ("autoSummarize", Rule::Bool),
    ("autoSummarizePreset", Rule::Any),
    ("syncInterval", Rule::Number),
    ("autoSyncEnabled", Rule::Bool),
    ("syncOnMount", Rule::Bool),
    ("syncOnVisibilityChange", Rule::Bool),
    ("syncNotifications", Rule::Bool),
    ("defaultPlaybackSpeed", Rule::Number),
    ("defaultVolume", Rule::Number),
    ("autoPlayNext", Rule::Bool),
    ("playerScrubber", Rule::OneOf(&["waveform", "slider"])),
    ("defaultTranscriptionLanguage", Rule::Any),
    (
        "transcriptionQuality",
        Rule::OneOf(&["fast", "balanced", "accurate"]),
    ),
    ("speakerDiarization", Rule::Bool),
    ("diarizationSpeakerCount", Rule::Speakers),
    (
        "dateTimeFormat",
        Rule::OneOf(&["relative", "absolute", "iso"]),
    ),
    (
        "recordingListSortOrder",
        Rule::OneOf(&["newest", "oldest", "name"]),
    ),
    ("itemsPerPage", Rule::Number),
    ("listDensity", Rule::OneOf(&["comfortable", "compact"])),
    ("theme", Rule::OneOf(&["light", "dark", "system"])),
    ("autoDeleteRecordings", Rule::Bool),
    ("retentionDays", Rule::NumberOrNull),
    ("browserNotifications", Rule::Bool),
    ("notificationSound", Rule::Bool),
    (
        "defaultExportFormat",
        Rule::OneOf(&["json", "txt", "srt", "vtt"]),
    ),
    ("autoExport", Rule::Bool),
    ("autoExportFolder", Rule::StringOrNull),
    ("autoExportFormat", Rule::OneOf(&["mp3", "ogg", "original"])),
    (
        "autoExportTitleMode",
        Rule::OneOf(&["original", "date", "ai"]),
    ),
    ("backupFrequency", Rule::StringOrNull),
    ("backupFolder", Rule::StringOrNull),
    ("defaultProviders", Rule::ObjectOrNull),
    ("onboardingCompleted", Rule::Bool),
    ("autoGenerateTitle", Rule::Bool),
    (
        "recordingTitleMode",
        Rule::OneOf(&["original", "date", "ai"]),
    ),
    ("syncTitleToPlaud", Rule::Bool),
    ("aiOutputLanguage", Rule::Language),
    ("importPlaudContent", Rule::Bool),
    ("transcriptMode", Rule::OneOf(&["plaud_only", "keep_both"])),
    (
        "preferredTranscriptSource",
        Rule::OneOf(&["plaud", "openaudiohub"]),
    ),
    ("emailNotifications", Rule::Bool),
    ("notificationEmail", Rule::StringOrNull),
    ("barkNotifications", Rule::Bool),
];

/// Defaults for a brand-new account. Account-level and read-only fields are added in `get_user`.
const DEFAULTS_JSON: &str = r#"{
        "autoTranscribe": false,
        "autoSummarize": false,
        "autoSummarizePreset": null,
        "syncInterval": 300000,
        "autoSyncEnabled": true,
        "syncOnMount": true,
        "syncOnVisibilityChange": true,
        "syncNotifications": true,
        "defaultPlaybackSpeed": 1,
        "defaultVolume": 75,
        "autoPlayNext": false,
        "playerScrubber": "waveform",
        "defaultTranscriptionLanguage": null,
        "transcriptionQuality": "balanced",
        "speakerDiarization": true,
        "diarizationSpeakerCount": null,
        "dateTimeFormat": "relative",
        "recordingListSortOrder": "newest",
        "itemsPerPage": 50,
        "listDensity": "comfortable",
        "theme": "system",
        "autoDeleteRecordings": false,
        "retentionDays": null,
        "browserNotifications": true,
        "notificationSound": true,
        "defaultExportFormat": "json",
        "autoExport": false,
        "autoExportFolder": null,
        "autoExportFormat": "mp3",
        "autoExportTitleMode": "original",
        "backupFrequency": null,
        "backupFolder": null,
        "defaultProviders": null,
        "onboardingCompleted": false,
        "autoGenerateTitle": true,
        "recordingTitleMode": "ai",
        "syncTitleToPlaud": false,
        "aiOutputLanguage": null,
        "importPlaudContent": false,
        "transcriptMode": "plaud_only",
        "preferredTranscriptSource": "plaud",
        "titleGenerationPrompt": null,
        "emailNotifications": false,
        "notificationEmail": null,
        "barkNotifications": false,
        "marketingEmailConsent": false
}"#;

pub fn defaults() -> Map<String, Value> {
    serde_json::from_str(DEFAULTS_JSON).unwrap_or_default()
}

fn invalid(field: &str) -> AppError {
    AppError::bad_request("INVALID_INPUT", format!("Invalid value for {field}"))
        .detail("field", field)
}

/// The stored form of a value for a table rule, or `None` when it is not allowed.
fn check(rule: &Rule, value: &Value) -> Option<Value> {
    let ok = match rule {
        Rule::Bool => value.is_boolean(),
        Rule::Number => value.is_number(),
        Rule::NumberOrNull => value.is_number() || value.is_null(),
        Rule::Any => true,
        Rule::OneOf(allowed) => value.as_str().is_some_and(|s| allowed.contains(&s)),
        Rule::StringOrNull => value.is_string() || value.is_null(),
        Rule::ObjectOrNull => value.is_object() || value.is_null(),
        Rule::Speakers => value.is_null() || value.as_i64().is_some_and(|n| (1..=32).contains(&n)),
        Rule::Language => {
            value.is_null()
                || value
                    .as_str()
                    .is_some_and(|s| LANGUAGES.contains(&s.to_ascii_lowercase().as_str()))
        }
    };
    if !ok {
        return None;
    }
    Some(match (rule, value) {
        (Rule::Language, Value::String(code)) => json!(code.to_ascii_lowercase()),
        _ => value.clone(),
    })
}

/// `{ selectedPrompt?: string, customPrompts?: [{ id, name, prompt, createdAt }] }`, all strings (spec/ai.md).
fn is_summary_prompt(value: &Value) -> bool {
    let Some(obj) = value.as_object() else {
        return false;
    };
    let selected_ok = obj.get("selectedPrompt").is_none_or(Value::is_string);
    let prompts_ok = obj.get("customPrompts").is_none_or(|list| {
        list.as_array().is_some_and(|items| {
            items.iter().all(|p| {
                ["id", "name", "prompt", "createdAt"]
                    .iter()
                    .all(|k| p.get(k).is_some_and(Value::is_string))
            })
        })
    });
    selected_ok && prompts_ok
}

/// Validates one field of a PUT body and writes its stored form. Unknown fields are ignored.
fn apply(
    key: &FieldKey,
    stored: &mut Map<String, Value>,
    field: &str,
    value: &Value,
) -> ApiResult<()> {
    let stored_value = match field {
        "summaryPrompt" if is_summary_prompt(value) => key.encrypt_json(value),
        "titleGenerationPrompt" if value.is_string() => key.encrypt_json(value),
        "summaryPrompt" | "titleGenerationPrompt" if !value.is_null() => {
            return Err(invalid(field));
        }
        "summaryPrompt" => {
            stored.remove(field);
            return Ok(());
        }
        "titleGenerationPrompt" => Value::Null,
        // Account-level consent flag; anything but a boolean is ignored (spec/settings.md).
        "marketingEmailConsent" if value.is_boolean() => value.clone(),
        "marketingEmailConsent" => return Ok(()),
        // Stored encrypted. An empty string clears it (spec/settings.md).
        "barkPushUrl" => match value {
            Value::Null => Value::Null,
            Value::String(url) if url.trim().is_empty() => Value::Null,
            Value::String(url) => key.encrypt_json(&json!(url.trim())),
            _ => return Err(invalid(field)),
        },
        _ => match RULES.iter().find(|(name, _)| *name == field) {
            None => return Ok(()),
            Some((_, rule)) => check(rule, value).ok_or_else(|| invalid(field))?,
        },
    };
    stored.insert(field.to_owned(), stored_value);
    Ok(())
}

/// A folder that exists and is not read-only.
/// shortcut: checks the read-only flag, not an actual write; good enough for a settings check.
async fn writable_dir(path: &str) -> bool {
    tokio::fs::metadata(path)
        .await
        .is_ok_and(|m| m.is_dir() && !m.permissions().readonly())
}

fn parse_stored(data: Option<String>) -> ApiResult<Map<String, Value>> {
    match data {
        Some(text) => serde_json::from_str(&text).map_err(AppError::internal),
        None => Ok(Map::new()),
    }
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/settings/user", get(get_user).put(put_user))
        .route("/api/settings/storage", get(get_storage))
        .route("/api/settings/test-email", post(test_email))
}

/// `POST /api/settings/test-email` (spec/settings.md, Notifications). Uses the strict send,
/// so the caller sees why a mail did not go out. Each account may send 5 per 10 minutes.
async fn test_email(
    user: CurrentUser,
    State(state): State<AppState>,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    let email = serde_json::from_slice::<Value>(&body)
        .ok()
        .and_then(|v| {
            v.get("email")
                .and_then(Value::as_str)
                .map(|s| s.trim().to_owned())
        })
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            AppError::bad_request("MISSING_REQUIRED_FIELD", "Email is required")
                .detail("field", "email")
        })?;
    if !notify::is_plain_address(&email) {
        return Err(
            AppError::bad_request("INVALID_INPUT", "Enter a valid email address")
                .detail("field", "email"),
        );
    }
    let now = now_ms();
    let decision = state
        .limiter
        .hit(&format!("test-email:{}", user.id), 5, 10 * 60 * 1000, now);
    if !decision.allowed {
        return Err(auth::too_many(&decision, now));
    }
    match notify::send_test(&state.config, &email).await {
        Ok(()) => Ok(Json(json!({ "success": true }))),
        Err(SendError::NotConfigured) => Err(AppError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "SMTP_NOT_CONFIGURED",
            SendError::NotConfigured.to_string(),
        )),
        Err(SendError::AuthFailed) => Err(AppError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "SMTP_AUTH_FAILED",
            SendError::AuthFailed.to_string(),
        )),
        Err(SendError::Failed(message)) => Err(AppError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "EMAIL_SEND_FAILED",
            message,
        )),
    }
}

/// A user's settings with defaults filled in and encrypted fields opened. Used by
/// every module that acts on a user's preferences.
pub async fn effective(state: &AppState, user_id: &str) -> ApiResult<Map<String, Value>> {
    let data: Option<String> =
        sqlx::query_scalar("SELECT data FROM user_settings WHERE user_id = ?")
            .bind(user_id)
            .fetch_optional(&state.db)
            .await?;
    let mut out = defaults();
    for (field, value) in parse_stored(data)? {
        let value = match field.as_str() {
            "summaryPrompt" | "titleGenerationPrompt" | "barkPushUrl" if !value.is_null() => state
                .config
                .field_key
                .decrypt_json(&value)
                .map_err(AppError::internal)?,
            _ => value,
        };
        out.insert(field, value);
    }
    Ok(out)
}

async fn get_user(user: CurrentUser, State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let mut out = effective(&state, &user.id).await?;
    let last_backup: Option<i64> = sqlx::query_scalar(
        "SELECT MAX(completed_at) FROM export_jobs WHERE user_id = ? AND kind = 'scheduled'",
    )
    .bind(&user.id)
    .fetch_one(&state.db)
    .await?;
    let bark_url = out.entry("barkPushUrl").or_insert(Value::Null).clone();
    let bark_set = bark_url.as_str().is_some_and(|url| !url.is_empty());
    out.insert("barkPushUrlSet".into(), json!(bark_set));
    out.insert("userEmail".into(), user.email.into());
    out.insert("lastScheduledBackupAt".into(), last_backup.map(iso).into());
    Ok(Json(Value::Object(out)))
}

async fn put_user(
    user: CurrentUser,
    State(state): State<AppState>,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    let input = match serde_json::from_slice::<Value>(&body) {
        Ok(Value::Object(map)) => map,
        _ => {
            return Err(AppError::bad_request(
                "INVALID_INPUT",
                "Request body must be a JSON object",
            ));
        }
    };
    let mut tx = state.db.begin().await?;
    let data: Option<String> =
        sqlx::query_scalar("SELECT data FROM user_settings WHERE user_id = ?")
            .bind(&user.id)
            .fetch_optional(&mut *tx)
            .await?;
    let mut stored = parse_stored(data)?;

    for (field, value) in &input {
        // recordingTitleMode decides autoGenerateTitle, so a separate value is ignored.
        if field == "autoGenerateTitle" && input.contains_key("recordingTitleMode") {
            continue;
        }
        apply(&state.config.field_key, &mut stored, field, value)?;
    }
    if input.contains_key("recordingTitleMode") {
        let ai = stored.get("recordingTitleMode") == Some(&json!("ai"));
        stored.insert("autoGenerateTitle".into(), json!(ai));
    }

    for field in ["autoExportFolder", "backupFolder"] {
        let Some(path) = input.get(field).and_then(Value::as_str) else {
            continue;
        };
        // Only the desktop app writes to these folders; a web user must not probe the server's disk.
        if state.config.desktop.is_none() || !writable_dir(path).await {
            return Err(invalid(field));
        }
    }

    if input.get("autoExport") == Some(&Value::Bool(true)) {
        if state.config.desktop.is_none() {
            return Err(AppError::bad_request(
                "INVALID_INPUT",
                "Auto export is only available in the desktop app",
            )
            .detail("field", "autoExport"));
        }
        if stored
            .get("autoExportFolder")
            .and_then(Value::as_str)
            .is_none()
        {
            return Err(AppError::bad_request(
                "INVALID_INPUT",
                "Choose an export folder in the desktop app first",
            )
            .detail("field", "autoExport"));
        }
    }

    sqlx::query(
        "INSERT INTO user_settings (user_id, data, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
    )
    .bind(&user.id)
    .bind(Value::Object(stored).to_string())
    .bind(now_ms())
    .execute(&mut *tx)
    .await?;

    // The next export pass sees a new signature and clears the retry count of failed writes, so a
    // folder or format change resumes them. Nothing is exported retroactively: that is decided per
    // recording when it is added.
    sqlx::query("DELETE FROM auto_export_run WHERE user_id = ?")
        .bind(&user.id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(json!({ "success": true })))
}

#[derive(sqlx::FromRow)]
struct LargestRow {
    id: String,
    filename: String,
    filesize: i64,
    duration: i64,
    start_time: i64,
}

async fn get_storage(user: CurrentUser, State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let (used, count, total): (i64, i64, i64) = sqlx::query_as(
        "SELECT COALESCE(SUM(filesize), 0), COUNT(*), COALESCE(SUM(duration), 0)
         FROM recordings WHERE user_id = ? AND deleted_at IS NULL",
    )
    .bind(&user.id)
    .fetch_one(&state.db)
    .await?;
    let rows: Vec<LargestRow> = sqlx::query_as(
        "SELECT id, filename, filesize, duration, start_time FROM recordings
         WHERE user_id = ? AND deleted_at IS NULL ORDER BY filesize DESC, id DESC LIMIT 5",
    )
    .bind(&user.id)
    .fetch_all(&state.db)
    .await?;
    let mut largest = Vec::with_capacity(rows.len());
    for row in rows {
        let filename = state
            .config
            .field_key
            .decrypt(&row.filename)
            .map_err(AppError::internal)?;
        largest.push(json!({
            "id": row.id,
            "filename": filename,
            "filesize": row.filesize,
            "duration": row.duration,
            "startTime": iso(row.start_time),
        }));
    }
    let storage_type = state.storage.active_type();
    let disk_free = state.storage.disk_free_bytes();
    Ok(Json(json!({
        "storageType": storage_type,
        "usedBytes": used,
        "recordingCount": count,
        "totalDurationMs": total,
        "largest": largest,
        "diskFreeBytes": disk_free,
        "quotaBytes": null,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> FieldKey {
        FieldKey::from_hex(&"ab".repeat(32)).expect("valid key")
    }

    #[test]
    fn defaults_match_the_spec_and_hide_summary_prompt() {
        let d = defaults();
        assert_eq!(d["syncInterval"], json!(300000));
        assert_eq!(d["theme"], json!("system"));
        assert_eq!(d["autoGenerateTitle"], json!(true));
        assert!(!d.contains_key("summaryPrompt"));
        assert!(!d.contains_key("barkPushUrl"));
    }

    #[test]
    fn enums_accept_only_listed_values() {
        let theme = Rule::OneOf(&["light", "dark", "system"]);
        assert!(check(&theme, &json!("dark")).is_some());
        assert!(check(&theme, &json!("neon")).is_none());
        assert!(check(&theme, &Value::Null).is_none());
    }

    #[test]
    fn speaker_count_is_1_to_32_or_null() {
        for ok in [json!(1), json!(32), Value::Null] {
            assert!(check(&Rule::Speakers, &ok).is_some(), "{ok}");
        }
        for bad in [json!(0), json!(33), json!(2.5), json!("3")] {
            assert!(check(&Rule::Speakers, &bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn language_is_known_and_stored_lowercase() {
        assert_eq!(check(&Rule::Language, &json!("EN")), Some(json!("en")));
        assert!(check(&Rule::Language, &json!("zz-bogus")).is_none());
    }

    #[test]
    fn apply_ignores_unknown_and_rejects_bad_values() {
        let mut stored = Map::new();
        assert!(apply(&key(), &mut stored, "notARealSetting", &json!("x")).is_ok());
        assert!(stored.is_empty());
        let err = apply(&key(), &mut stored, "speakerDiarization", &json!("yes")).unwrap_err();
        assert_eq!(err.details["field"], json!("speakerDiarization"));
        assert!(apply(&key(), &mut stored, "theme", &Value::Null).is_err());
    }

    #[test]
    fn summary_prompt_must_be_an_object_and_null_clears_it() {
        let k = key();
        let mut stored = Map::new();
        assert!(apply(&k, &mut stored, "summaryPrompt", &json!("bad")).is_err());
        assert!(
            apply(
                &k,
                &mut stored,
                "summaryPrompt",
                &json!({ "selectedPrompt": 5 })
            )
            .is_err()
        );
        assert!(
            apply(
                &k,
                &mut stored,
                "summaryPrompt",
                &json!({ "customPrompts": [{ "id": "a" }] })
            )
            .is_err()
        );
        let good = json!({ "selectedPrompt": "cp", "customPrompts": [{ "id": "cp", "name": "n", "prompt": "p", "createdAt": "2026-10-16T00:00:00Z" }] });
        apply(&k, &mut stored, "summaryPrompt", &good).unwrap();
        apply(
            &k,
            &mut stored,
            "summaryPrompt",
            &json!({ "text": "short" }),
        )
        .unwrap();
        let round = k.decrypt_json(&stored["summaryPrompt"]).unwrap();
        assert_eq!(round, json!({ "text": "short" }));
        apply(&k, &mut stored, "summaryPrompt", &Value::Null).unwrap();
        assert!(!stored.contains_key("summaryPrompt"));
    }

    #[test]
    fn bark_url_is_encrypted_and_empty_clears_it() {
        let k = key();
        let mut stored = Map::new();
        apply(
            &k,
            &mut stored,
            "barkPushUrl",
            &json!("https://api.day.app/abc"),
        )
        .unwrap();
        assert_ne!(stored["barkPushUrl"], json!("https://api.day.app/abc"));
        assert_eq!(
            k.decrypt_json(&stored["barkPushUrl"]).unwrap(),
            json!("https://api.day.app/abc")
        );
        apply(&k, &mut stored, "barkPushUrl", &json!("  ")).unwrap();
        assert_eq!(stored["barkPushUrl"], Value::Null);
        assert!(apply(&k, &mut stored, "barkPushUrl", &json!(5)).is_err());
        apply(&k, &mut stored, "emailNotifications", &json!(true)).unwrap();
        assert_eq!(stored["emailNotifications"], json!(true));
    }

    #[test]
    fn title_prompt_is_encrypted_at_rest() {
        let k = key();
        let mut stored = Map::new();
        apply(
            &k,
            &mut stored,
            "titleGenerationPrompt",
            &json!("Name it after the topic"),
        )
        .unwrap();
        assert_ne!(
            stored["titleGenerationPrompt"],
            json!("Name it after the topic")
        );
        assert_eq!(
            k.decrypt_json(&stored["titleGenerationPrompt"]).unwrap(),
            json!("Name it after the topic")
        );
    }
}
