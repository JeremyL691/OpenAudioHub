//! AI provider settings (spec/ai.md: "Provider presets" and the provider endpoints).
//! Google Gemini and ElevenLabs use their own APIs; every other preset is OpenAI-compatible.

use std::time::{Duration, Instant};

use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post, put};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{Sqlite, Transaction};

use crate::AppState;
use crate::ai::{
    PRESETS, Preset, base_url, can_enhance, can_transcribe, client, is_transcription_model,
};
use crate::auth::CurrentUser;
use crate::db::now_ms;
use crate::error::{ApiResult, AppError};
use crate::ids::new_id;
use crate::time::iso;

const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
const LIST_TIMEOUT: Duration = Duration::from_secs(10);
/// Chat model ids containing these words are not offered (shortcut: guessed pattern, the spec does not name one).
const EXCLUDED_CHAT_MODELS: &[&str] = &["embed", "rerank", "tts"];
const SELECT: &str = "SELECT id, provider, api_key, base_url, default_model, is_default_transcription, \
                      is_default_enhancement, created_at FROM api_credentials";

#[derive(sqlx::FromRow)]
struct Row {
    id: String,
    provider: String,
    api_key: String,
    base_url: Option<String>,
    default_model: Option<String>,
    is_default_transcription: bool,
    is_default_enhancement: bool,
    created_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderBody {
    provider: Option<String>,
    api_key: Option<String>,
    base_url: Option<String>,
    default_model: Option<String>,
    #[serde(default)]
    is_default_transcription: bool,
    #[serde(default)]
    is_default_enhancement: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TestBody {
    provider: Option<String>,
    model: Option<String>,
    api_key: Option<String>,
    base_url: Option<String>,
    id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelsBody {
    provider: Option<String>,
    api_key: Option<String>,
    base_url: Option<String>,
    kind: Option<String>,
}

#[derive(Deserialize)]
struct Listed {
    #[serde(default)]
    data: Vec<ListedModel>,
}

#[derive(Deserialize)]
struct ListedModel {
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    architecture: Option<Architecture>,
}

#[derive(Deserialize)]
struct Architecture {
    #[serde(default)]
    input_modalities: Vec<String>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/settings/ai/providers", get(list).post(create))
        .route(
            "/api/settings/ai/providers/{id}",
            put(update).delete(remove),
        )
        .route(
            "/api/settings/ai/providers/default-transcription",
            put(set_default_transcription),
        )
        .route("/api/settings/ai/providers/test", post(probe))
        .route(
            "/api/settings/ai/providers/{id}/chat-models",
            get(saved_chat_models),
        )
        .route("/api/settings/ai/providers/models", post(models))
}

/// The chat models a saved provider offers, with what this server has verified about them
/// (spec/recording-chat.md). The key is used here and never returned.
async fn saved_chat_models(
    State(state): State<AppState>,
    user: CurrentUser,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> ApiResult<Json<Value>> {
    let row: Option<Row> = sqlx::query_as(&format!("{SELECT} WHERE id = ? AND user_id = ?"))
        .bind(&id)
        .bind(&user.id)
        .fetch_optional(&state.db)
        .await?;
    let row = row.ok_or_else(|| AppError::not_found("NOT_FOUND", "Provider not found"))?;
    let preset = crate::ai::preset_named(&row.provider);
    let base = crate::ai::base_url(row.base_url.clone(), preset);
    let api_key = state
        .config
        .field_key
        .decrypt(&row.api_key)
        .map_err(AppError::internal)?;
    // A provider that publishes its models is asked; otherwise the configured model and the
    // preset's suggestions are offered, so a picker is never empty for a working provider.
    let mut models: Vec<Value> = Vec::new();
    if preset.is_some_and(|p| p.lists_chat) {
        let request = crate::ai::with_provider_headers(
            crate::ai::client()
                .get(format!("{base}/models"))
                .bearer_auth(&api_key),
            &row.provider,
            &base,
        );
        if let Ok(response) = request.timeout(LIST_TIMEOUT).send().await
            && let Ok(listed) = response.json::<Listed>().await
        {
            for model in listed.data {
                let id = model.id;
                let lower = id.to_lowercase();
                if EXCLUDED_CHAT_MODELS.iter().any(|word| lower.contains(word)) {
                    continue;
                }
                if is_transcription_model(&id) {
                    continue;
                }
                models.push(json!({ "id": id, "name": model.name.unwrap_or_else(|| id.clone()) }));
            }
        }
        models.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    }
    let configured = row
        .default_model
        .clone()
        .filter(|m| !m.is_empty() && !is_transcription_model(m));
    let answer = json!({
        "models": models,
        "configuredModel": configured,
        "managedModel": crate::ai::chat_model_of(&row.provider, row.default_model.as_deref(), &base),
    });
    Ok(Json(answer))
}

async fn list(State(state): State<AppState>, user: CurrentUser) -> ApiResult<Json<Value>> {
    let rows: Vec<Row> = sqlx::query_as(&format!(
        "{SELECT} WHERE user_id = ? ORDER BY created_at, id"
    ))
    .bind(&user.id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(
        json!({ "providers": rows.iter().map(view).collect::<Vec<_>>() }),
    ))
}

async fn create(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(body): Json<ProviderBody>,
) -> ApiResult<Json<Value>> {
    let provider = non_empty(body.provider).ok_or_else(|| missing("provider"))?;
    let api_key = non_empty(body.api_key).ok_or_else(|| missing("apiKey"))?;
    let preset = preset_for_use(&provider)?;
    validate_provider_base(&provider, body.base_url.as_deref())?;
    if body.is_default_enhancement && !can_enhance(&provider) {
        return Err(refuse("isDefaultEnhancement"));
    }
    if body.is_default_transcription && !preset.is_none_or(|p| p.transcribes) {
        return Err(refuse("isDefaultTranscription"));
    }
    let now = now_ms();
    let row = Row {
        id: new_id(),
        provider,
        api_key: state.config.field_key.encrypt(&api_key),
        base_url: non_empty(body.base_url),
        default_model: non_empty(body.default_model),
        is_default_transcription: body.is_default_transcription,
        is_default_enhancement: body.is_default_enhancement,
        created_at: now,
    };

    let mut tx = crate::db::begin_write(&state.db).await?;
    if row.is_default_transcription {
        clear_default(&mut tx, &user.id, true).await?;
    }
    if row.is_default_enhancement {
        clear_default(&mut tx, &user.id, false).await?;
    }
    sqlx::query(
        "INSERT INTO api_credentials (id, user_id, provider, api_key, base_url, default_model,
         is_default_transcription, is_default_enhancement, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&row.id)
    .bind(&user.id)
    .bind(&row.provider)
    .bind(&row.api_key)
    .bind(&row.base_url)
    .bind(&row.default_model)
    .bind(row.is_default_transcription)
    .bind(row.is_default_enhancement)
    .bind(now)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(json!({ "provider": view(&row) })))
}

async fn update(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Json(body): Json<ProviderBody>,
) -> ApiResult<Json<Value>> {
    let mut tx = crate::db::begin_write(&state.db).await?;
    let row = find(&mut *tx, &user.id, &id)
        .await?
        .ok_or_else(missing_provider)?;
    validate_provider_base(&row.provider, body.base_url.as_deref())?;
    if body.is_default_enhancement && !can_enhance(&row.provider) {
        return Err(refuse("isDefaultEnhancement"));
    }
    if body.is_default_transcription && !can_transcribe(&row.provider) {
        return Err(refuse("isDefaultTranscription"));
    }
    // A missing or empty key keeps the stored one.
    let api_key = match non_empty(body.api_key) {
        Some(key) => state.config.field_key.encrypt(&key),
        None => row.api_key,
    };
    if body.is_default_transcription {
        clear_default(&mut tx, &user.id, true).await?;
    }
    if body.is_default_enhancement {
        clear_default(&mut tx, &user.id, false).await?;
    }
    sqlx::query(
        "UPDATE api_credentials SET api_key = ?, base_url = ?, default_model = ?,
         is_default_transcription = ?, is_default_enhancement = ?, updated_at = ?
         WHERE id = ? AND user_id = ?",
    )
    .bind(api_key)
    .bind(non_empty(body.base_url))
    .bind(non_empty(body.default_model))
    .bind(body.is_default_transcription)
    .bind(body.is_default_enhancement)
    .bind(now_ms())
    .bind(&id)
    .bind(&user.id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(json!({ "success": true })))
}

async fn remove(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    // Deleting the row also clears it as the transcription default. Unknown ids are not an error.
    sqlx::query("DELETE FROM api_credentials WHERE id = ? AND user_id = ?")
        .bind(&id)
        .bind(&user.id)
        .execute(&state.db)
        .await?;
    Ok(Json(json!({ "success": true })))
}

async fn set_default_transcription(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let Some(id) = body
        .get("providerId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    else {
        return Err(
            AppError::bad_request("INVALID_INPUT", "Invalid request body")
                .detail("issues", json!(["providerId must be a non-empty string"])),
        );
    };
    let mut tx = crate::db::begin_write(&state.db).await?;
    let row = find(&mut *tx, &user.id, id)
        .await?
        .ok_or_else(missing_provider)?;
    if !can_transcribe(&row.provider) {
        return Err(refuse("isDefaultTranscription"));
    }
    clear_default(&mut tx, &user.id, true).await?;
    sqlx::query("UPDATE api_credentials SET is_default_transcription = 1, updated_at = ? WHERE id = ? AND user_id = ?")
        .bind(now_ms())
        .bind(id)
        .bind(&user.id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(json!({ "success": true })))
}

/// Tests a connection with one small upstream call. Upstream failures are reported inside a 200.
async fn probe(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(body): Json<TestBody>,
) -> ApiResult<Json<Value>> {
    let stored = match non_empty(body.id) {
        Some(id) => Some(
            find(&state.db, &user.id, &id)
                .await?
                .ok_or_else(missing_provider)?,
        ),
        None => None,
    };
    let key = match (non_empty(body.api_key), &stored) {
        (Some(key), _) => key,
        (None, Some(row)) => state
            .config
            .field_key
            .decrypt(&row.api_key)
            .map_err(AppError::internal)?,
        (None, None) => return Err(missing("apiKey")),
    };
    let provider = non_empty(body.provider)
        .or_else(|| stored.as_ref().map(|row| row.provider.clone()))
        .ok_or_else(|| missing("provider"))?;
    let preset = preset_for_use(&provider)?;
    let base = base_url(
        non_empty(body.base_url).or_else(|| stored.as_ref().and_then(|row| row.base_url.clone())),
        preset,
    );
    validate_provider_base(&provider, Some(&base))?;
    let model = non_empty(body.model)
        .or_else(|| stored.as_ref().and_then(|row| row.default_model.clone()))
        .or_else(|| preset.and_then(|p| p.model).map(str::to_owned));
    let Some(model) = model else {
        return Ok(Json(
            json!({ "ok": false, "kind": "chat", "error": "No model is set." }),
        ));
    };

    let transcription = !can_enhance(&provider)
        || is_transcription_model(&model)
        || (provider == "Google Gemini" && gemini_audio_models().contains(&model.as_str()));
    let kind = if transcription {
        "transcription"
    } else {
        "chat"
    };
    let started = Instant::now();
    let outcome = if provider == "Google Gemini" && transcription {
        gemini_audio_probe(&key, &model).await
    } else if provider == "Google Gemini" {
        gemini_chat_probe(&key, &model).await
    } else if transcription {
        if provider == "ElevenLabs" {
            eleven_probe(&base, &key, &model).await
        } else {
            transcribe_probe(&base, &key, &model).await
        }
    } else {
        chat_probe(&provider, &base, &key, &model).await
    };
    Ok(Json(match outcome {
        Ok(()) => {
            json!({ "ok": true, "kind": kind, "latencyMs": started.elapsed().as_millis() as u64 })
        }
        Err(failure) => {
            json!({ "ok": false, "kind": kind, "error": mask_key(&probe_error(failure), &key) })
        }
    }))
}

/// Lists models for the picker. Nothing is saved.
async fn models(_user: CurrentUser, Json(body): Json<ModelsBody>) -> ApiResult<Json<Value>> {
    let provider = non_empty(body.provider).ok_or_else(|| missing("provider"))?;
    let key = non_empty(body.api_key).ok_or_else(|| missing("apiKey"))?;
    let chat = body.kind.as_deref() == Some("chat");
    if provider == "Google Gemini" && !chat {
        let models = [
            "gemini-2.0-flash",
            "gemini-2.5-flash",
            "gemini-2.5-pro",
            "gemini-1.5-flash",
            "gemini-1.5-pro",
        ]
        .into_iter()
        .map(|id| json!({"id":id,"name":id}))
        .collect::<Vec<_>>();
        return Ok(Json(json!({"models":models})));
    }
    if provider == "ElevenLabs" && !chat {
        let models = ["scribe_v2", "scribe_v1"]
            .into_iter()
            .map(|id| json!({"id":id,"name":id}))
            .collect::<Vec<_>>();
        return Ok(Json(json!({"models":models})));
    }
    // Anything other than chat is audio, as the spec says.
    let Some(preset) =
        preset_for_use(&provider)?.filter(|p| if chat { p.lists_chat } else { p.lists_audio })
    else {
        return Ok(Json(json!({ "models": [] })));
    };
    let base = base_url(non_empty(body.base_url), Some(preset));
    validate_provider_base(&provider, Some(&base))?;
    if provider == "Google Gemini" {
        // Gemini chat models have no list endpoint here (spec/ai.md, models).
        return Ok(Json(json!({ "models": [] })));
    }
    let url = format!("{base}/models");
    let req =
        crate::ai::with_provider_headers(client().get(url).bearer_auth(&key), &provider, &base);
    let res = call(req, LIST_TIMEOUT).await.map_err(listing_error)?;
    let listed: Listed = res.json().await.map_err(|_| {
        AppError::new(
            StatusCode::BAD_GATEWAY,
            "AI_PROVIDER_API_ERROR",
            "The provider sent an unreadable reply.",
        )
    })?;
    let models = if chat {
        chat_models(listed.data)
    } else {
        audio_models(listed.data)
    };
    Ok(Json(json!({ "models": models })))
}

// ---- upstream calls -------------------------------------------------------

/// Why an upstream call failed. Provider text is never kept.
#[derive(Clone, Copy)]
enum Upstream {
    Timeout,
    Unreachable,
    Refused(u16),
}

async fn call(
    req: reqwest::RequestBuilder,
    timeout: Duration,
) -> Result<reqwest::Response, Upstream> {
    let res = req.timeout(timeout).send().await.map_err(|e| {
        if e.is_timeout() {
            Upstream::Timeout
        } else {
            Upstream::Unreachable
        }
    })?;
    if res.status().is_success() {
        Ok(res)
    } else {
        Err(Upstream::Refused(res.status().as_u16()))
    }
}

async fn chat_probe(provider: &str, base: &str, key: &str, model: &str) -> Result<(), Upstream> {
    let body = json!({
        "model": model,
        "messages": [{ "role": "user", "content": "Reply with OK." }],
        "max_tokens": 16,
    });
    let req = client()
        .post(format!("{base}/chat/completions"))
        .bearer_auth(key)
        .json(&body);
    let req = crate::ai::with_provider_headers(req, provider, base);
    call(req, PROBE_TIMEOUT).await.map(|_| ())
}

async fn gemini_chat_probe(key: &str, model: &str) -> Result<(), Upstream> {
    let req = client().post(format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"))
        .header("x-goog-api-key", key).json(&json!({"contents":[{"parts":[{"text":"Reply with OK."}]}],"generationConfig":{"maxOutputTokens":16,"temperature":0}}));
    call(req, PROBE_TIMEOUT).await.map(|_| ())
}

async fn gemini_audio_probe(key: &str, model: &str) -> Result<(), Upstream> {
    let audio = silent_mp3();
    let encoded = base64(&audio);
    let req = client().post(format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"))
        .header("x-goog-api-key", key).json(&json!({"contents":[{"parts":[{"text":"Transcribe this audio."},{"inlineData":{"mimeType":"audio/mp3","data":encoded}}]}],"generationConfig":{"maxOutputTokens":16,"temperature":0}}));
    call(req, PROBE_TIMEOUT).await.map(|_| ())
}

fn gemini_audio_models() -> [&'static str; 5] {
    [
        "gemini-2.0-flash",
        "gemini-2.5-flash",
        "gemini-2.5-pro",
        "gemini-1.5-flash",
        "gemini-1.5-pro",
    ]
}

fn base64(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for i in 0..4 {
            result.push(if i > chunk.len() {
                '='
            } else {
                TABLE[((n >> (18 - 6 * i)) & 63) as usize] as char
            });
        }
    }
    result
}

async fn eleven_probe(base: &str, key: &str, model: &str) -> Result<(), Upstream> {
    let file = reqwest::multipart::Part::bytes(silent_mp3())
        .file_name("silence.mp3")
        .mime_str("audio/mpeg")
        .unwrap();
    let form = reqwest::multipart::Form::new()
        .text("model_id", model.to_owned())
        .part("file", file)
        .text("timestamps_granularity", "word")
        .text("tag_audio_events", "false")
        .text("diarize", "false");
    let req = client()
        .post(format!("{base}/speech-to-text"))
        .header("xi-api-key", key)
        .multipart(form);
    call(req, PROBE_TIMEOUT).await.map(|_| ())
}

async fn transcribe_probe(base: &str, key: &str, model: &str) -> Result<(), Upstream> {
    let file = reqwest::multipart::Part::bytes(silent_mp3()).file_name("silence.mp3");
    let form = reqwest::multipart::Form::new()
        .text("model", model.to_owned())
        .part("file", file);
    let req = client()
        .post(format!("{base}/audio/transcriptions"))
        .bearer_auth(key)
        .multipart(form);
    call(req, PROBE_TIMEOUT).await.map(|_| ())
}

/// One second of silent MPEG-1 Layer III audio: 38 frames of 417 bytes (128 kbps, 44.1 kHz).
fn silent_mp3() -> Vec<u8> {
    let mut frame = vec![0u8; 417];
    frame[..4].copy_from_slice(&[0xFF, 0xFB, 0x90, 0x64]);
    frame.repeat(38)
}

fn probe_error(failure: Upstream) -> String {
    match failure {
        Upstream::Timeout => "The provider did not answer in time.".into(),
        Upstream::Unreachable => "Connection error.".into(),
        Upstream::Refused(401 | 403) => "The provider rejected the API key.".into(),
        Upstream::Refused(code) => format!("The provider answered with HTTP {code}."),
    }
}

fn listing_error(failure: Upstream) -> AppError {
    const CODE: &str = "AI_PROVIDER_API_ERROR";
    match failure {
        Upstream::Timeout => AppError::new(
            StatusCode::GATEWAY_TIMEOUT,
            CODE,
            "The provider did not answer in time.",
        ),
        Upstream::Unreachable => AppError::new(
            StatusCode::BAD_GATEWAY,
            CODE,
            "The provider could not be reached.",
        ),
        Upstream::Refused(401 | 403) => AppError::new(
            StatusCode::UNAUTHORIZED,
            CODE,
            "The provider rejected the API key.",
        ),
        Upstream::Refused(_) => AppError::new(
            StatusCode::BAD_GATEWAY,
            CODE,
            "The provider returned an error.",
        ),
    }
}

// ---- rules and helpers ----------------------------------------------------

fn preset_for_use(name: &str) -> ApiResult<Option<&'static Preset>> {
    Ok(PRESETS.iter().find(|p| p.name == name))
}

fn validate_provider_base(name: &str, base: Option<&str>) -> ApiResult<()> {
    if name != "ElevenLabs" {
        return Ok(());
    }
    let valid = base
        .filter(|s| !s.trim().is_empty())
        .and_then(|s| reqwest::Url::parse(s).ok())
        .is_some_and(|url| {
            matches!(url.scheme(), "http" | "https")
                && url.username().is_empty()
                && url.password().is_none()
        });
    if base.is_some_and(|s| !s.trim().is_empty()) && !valid {
        return Err(
            AppError::bad_request("INVALID_INPUT", "Invalid ElevenLabs base URL")
                .detail("field", "baseUrl"),
        );
    }
    Ok(())
}

/// Removes the key from error text and keeps it within 300 characters.
fn mask_key(text: &str, key: &str) -> String {
    let masked = if key.is_empty() {
        text.to_owned()
    } else {
        text.replace(key, "***")
    };
    masked.chars().take(300).collect()
}

fn chat_models(listed: Vec<ListedModel>) -> Vec<Value> {
    let mut ids: Vec<String> = listed
        .into_iter()
        .map(|m| m.id)
        .filter(|id| {
            let lower = id.to_lowercase();
            !EXCLUDED_CHAT_MODELS.iter().any(|word| lower.contains(word))
        })
        .collect();
    ids.sort();
    ids.into_iter()
        .map(|id| json!({ "id": id, "name": id }))
        .collect()
}

fn audio_models(listed: Vec<ListedModel>) -> Vec<Value> {
    let mut models: Vec<(String, String)> = listed
        .into_iter()
        .filter(|m| {
            m.architecture
                .as_ref()
                .is_some_and(|a| a.input_modalities.iter().any(|x| x == "audio"))
        })
        .map(|m| {
            (
                m.name
                    .filter(|n| !n.is_empty())
                    .unwrap_or_else(|| m.id.clone()),
                m.id,
            )
        })
        .collect();
    models.sort();
    models
        .into_iter()
        .map(|(name, id)| json!({ "id": id, "name": name }))
        .collect()
}

fn view(row: &Row) -> Value {
    json!({
        "id": row.id,
        "provider": row.provider,
        "baseUrl": row.base_url,
        "defaultModel": row.default_model,
        "isDefaultTranscription": row.is_default_transcription,
        "isDefaultEnhancement": row.is_default_enhancement,
        "createdAt": iso(row.created_at),
    })
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|s| !s.trim().is_empty())
}

fn missing(field: &str) -> AppError {
    AppError::bad_request("MISSING_REQUIRED_FIELD", format!("{field} is required"))
        .detail("field", field)
}

fn missing_provider() -> AppError {
    AppError::not_found("NOT_FOUND", "Provider not found")
}

fn refuse(field: &str) -> AppError {
    AppError::bad_request("INVALID_INPUT", "Provider cannot be used for this setting")
        .detail("field", field)
}

async fn find(
    db: impl sqlx::Executor<'_, Database = Sqlite>,
    user: &str,
    id: &str,
) -> sqlx::Result<Option<Row>> {
    sqlx::query_as(&format!("{SELECT} WHERE id = ? AND user_id = ?"))
        .bind(id)
        .bind(user)
        .fetch_optional(db)
        .await
}

async fn clear_default(
    tx: &mut Transaction<'_, Sqlite>,
    user: &str,
    transcription: bool,
) -> sqlx::Result<()> {
    let sql = if transcription {
        "UPDATE api_credentials SET is_default_transcription = 0 WHERE user_id = ?"
    } else {
        "UPDATE api_credentials SET is_default_enhancement = 0 WHERE user_id = ?"
    };
    sqlx::query(sql).bind(user).execute(&mut **tx).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_the_key_and_caps_the_length() {
        assert_eq!(mask_key("bad key sk-1 here", "sk-1"), "bad key *** here");
        assert_eq!(mask_key("no key", ""), "no key");
        assert_eq!(mask_key(&"x".repeat(400), "k").chars().count(), 300);
    }

    #[test]
    fn native_providers_are_supported_and_custom_names_accepted() {
        assert_eq!(
            preset_for_use("ElevenLabs").unwrap().unwrap().model,
            Some("scribe_v2")
        );
        assert_eq!(
            preset_for_use("Google Gemini").unwrap().unwrap().model,
            Some("gemini-2.0-flash")
        );
        assert!(preset_for_use("Gemini").is_ok());
        assert!(preset_for_use("Custom").is_ok());
    }

    #[test]
    fn elevenlabs_base_url_requires_http_without_credentials() {
        assert!(validate_provider_base("ElevenLabs", Some("https://localhost:3320/v1")).is_ok());
        assert!(validate_provider_base("ElevenLabs", Some("file:///tmp/x")).is_err());
        assert!(
            validate_provider_base("ElevenLabs", Some("https://user:pass@example.com/v1")).is_err()
        );
    }

    #[test]
    fn only_opencode_go_is_refused_as_transcriber() {
        assert!(!can_transcribe("OpenCode Go"));
        assert!(can_transcribe("Custom"));
        assert!(can_transcribe("my-own-server"));
    }

    #[test]
    fn transcription_models_are_recognised_by_name() {
        assert!(is_transcription_model("fake-whisper-1"));
        assert!(is_transcription_model("FunAudioLLM/SenseVoiceSmall"));
        assert!(is_transcription_model("scribe_v2"));
        assert!(!is_transcription_model("fake-chat-1"));
        assert!(!is_transcription_model("deepseek-v4.1-flash"));
    }

    #[test]
    fn chat_models_drop_excluded_ids_and_sort() {
        let listed: Listed = serde_json::from_value(json!({
            "data": [{ "id": "b-chat" }, { "id": "text-embedding-3" }, { "id": "a-chat" }]
        }))
        .unwrap();
        let models = chat_models(listed.data);
        assert_eq!(
            models,
            vec![
                json!({ "id": "a-chat", "name": "a-chat" }),
                json!({ "id": "b-chat", "name": "b-chat" })
            ]
        );
    }

    #[test]
    fn audio_models_need_audio_input_and_sort_by_name() {
        let listed: Listed = serde_json::from_value(json!({
            "data": [
                { "id": "x/text", "name": "Zed", "architecture": { "input_modalities": ["text"] } },
                { "id": "x/audio", "name": "Ada", "architecture": { "input_modalities": ["text", "audio"] } },
                { "id": "x/plain" },
                { "id": "x/noname", "architecture": { "input_modalities": ["audio"] } }
            ]
        }))
        .unwrap();
        let models = audio_models(listed.data);
        assert_eq!(
            models,
            vec![
                json!({ "id": "x/audio", "name": "Ada" }),
                json!({ "id": "x/noname", "name": "x/noname" })
            ]
        );
    }

    #[test]
    fn silent_clip_is_mp3_frames() {
        let clip = silent_mp3();
        assert_eq!(clip.len(), 417 * 38);
        assert_eq!(&clip[..4], &[0xFF, 0xFB, 0x90, 0x64]);
    }
}
