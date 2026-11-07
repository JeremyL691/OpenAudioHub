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

#[derive(sqlx::FromRow)]
struct Row {
    id: String,
    provider: String,
    api_key: String,
    base_url: Option<String>,
    default_model: Option<String>,
    transcription_model: Option<String>,
    enhancement_model: Option<String>,
    transcription_models: String,
    enhancement_models: String,
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
    transcription_model: Option<String>,
    #[serde(default)]
    enhancement_model: Option<String>,
    #[serde(default)]
    transcription_models: Option<Vec<String>>,
    #[serde(default)]
    enhancement_models: Option<Vec<String>>,
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
    #[serde(default)]
    kind: Option<String>,
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
        .route(
            "/api/settings/ai/providers/default-enhancement",
            put(set_default_enhancement),
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
    let row: Option<Row> = sqlx::query_as(
        "SELECT id, provider, api_key, base_url, default_model, \
         transcription_model, enhancement_model, transcription_models, enhancement_models, \
         is_default_transcription, is_default_enhancement, created_at FROM api_credentials WHERE id = ? AND user_id = ?",
    )
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
    for id in parse_stored_models(&row.enhancement_models) {
        if !is_transcription_model(&id)
            && !models.iter().any(|m| m["id"].as_str() == Some(id.as_str()))
        {
            models.push(json!({ "id": id, "name": id }));
        }
    }
    if row.provider == "Google Gemini" {
        for id in gemini_chat_models() {
            if !models.iter().any(|m| m["id"].as_str() == Some(id)) {
                models.push(json!({ "id": id, "name": id }));
            }
        }
    } else if preset.is_some_and(|p| p.lists_chat) {
        let request = crate::ai::with_provider_headers(
            crate::ai::client()
                .get(format!("{base}/models"))
                .bearer_auth(&api_key),
            &row.provider,
            &base,
        );
        let mut upstream_models: Vec<Value> = Vec::new();
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
                upstream_models
                    .push(json!({ "id": id, "name": model.name.unwrap_or_else(|| id.clone()) }));
            }
        }
        upstream_models.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
        for item in upstream_models {
            if let Some(id) = item["id"].as_str()
                && !models.iter().any(|m| m["id"].as_str() == Some(id))
            {
                models.push(item);
            }
        }
    }
    let configured = non_empty(row.enhancement_model.clone())
        .or_else(|| non_empty(row.default_model.clone()).filter(|m| !is_transcription_model(m)));
    let answer = json!({
        "models": models,
        "configuredModel": configured,
        "managedModel": crate::ai::chat_model_of(&row.provider, configured.as_deref(), &base),
    });
    Ok(Json(answer))
}

async fn list(State(state): State<AppState>, user: CurrentUser) -> ApiResult<Json<Value>> {
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT id, provider, api_key, base_url, default_model, \
         transcription_model, enhancement_model, transcription_models, enhancement_models, \
         is_default_transcription, is_default_enhancement, created_at FROM api_credentials WHERE user_id = ? ORDER BY created_at, id",
    )
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
    let normalized = normalize_models(
        &provider,
        body.default_model,
        body.transcription_model,
        body.enhancement_model,
        body.transcription_models,
        body.enhancement_models,
    );
    let row = Row {
        id: new_id(),
        provider,
        api_key: state.config.field_key.encrypt(&api_key),
        base_url: non_empty(body.base_url),
        default_model: normalized.default_model,
        transcription_model: normalized.transcription_model,
        enhancement_model: normalized.enhancement_model,
        transcription_models: serde_json::to_string(&normalized.transcription_models)
            .unwrap_or_else(|_| "[]".to_owned()),
        enhancement_models: serde_json::to_string(&normalized.enhancement_models)
            .unwrap_or_else(|_| "[]".to_owned()),
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
         transcription_model, enhancement_model, transcription_models, enhancement_models,
         is_default_transcription, is_default_enhancement, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&row.id)
    .bind(&user.id)
    .bind(&row.provider)
    .bind(&row.api_key)
    .bind(&row.base_url)
    .bind(&row.default_model)
    .bind(&row.transcription_model)
    .bind(&row.enhancement_model)
    .bind(&row.transcription_models)
    .bind(&row.enhancement_models)
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
    let normalized = normalize_models(
        &row.provider,
        body.default_model,
        body.transcription_model,
        body.enhancement_model,
        body.transcription_models,
        body.enhancement_models,
    );
    let transcription_models =
        serde_json::to_string(&normalized.transcription_models).unwrap_or_else(|_| "[]".to_owned());
    let enhancement_models =
        serde_json::to_string(&normalized.enhancement_models).unwrap_or_else(|_| "[]".to_owned());
    if body.is_default_transcription {
        clear_default(&mut tx, &user.id, true).await?;
    }
    if body.is_default_enhancement {
        clear_default(&mut tx, &user.id, false).await?;
    }
    sqlx::query(
        "UPDATE api_credentials SET api_key = ?, base_url = ?, default_model = ?,
         transcription_model = ?, enhancement_model = ?, transcription_models = ?, enhancement_models = ?,
         is_default_transcription = ?, is_default_enhancement = ?, updated_at = ?
         WHERE id = ? AND user_id = ?",
    )
    .bind(api_key)
    .bind(non_empty(body.base_url))
    .bind(normalized.default_model)
    .bind(normalized.transcription_model)
    .bind(normalized.enhancement_model)
    .bind(transcription_models)
    .bind(enhancement_models)
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
    if let Some(model) = body
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        sqlx::query(
            "UPDATE api_credentials SET is_default_transcription = 1, transcription_model = ?, updated_at = ? WHERE id = ? AND user_id = ?",
        )
        .bind(model)
        .bind(now_ms())
        .bind(id)
        .bind(&user.id)
        .execute(&mut *tx)
        .await?;
    } else {
        sqlx::query("UPDATE api_credentials SET is_default_transcription = 1, updated_at = ? WHERE id = ? AND user_id = ?")
            .bind(now_ms())
            .bind(id)
            .bind(&user.id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(Json(json!({ "success": true })))
}

async fn set_default_enhancement(
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
    if !can_enhance(&row.provider) {
        return Err(refuse("isDefaultEnhancement"));
    }
    clear_default(&mut tx, &user.id, false).await?;
    if let Some(model) = body
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        sqlx::query(
            "UPDATE api_credentials SET is_default_enhancement = 1, enhancement_model = ?, updated_at = ? WHERE id = ? AND user_id = ?",
        )
        .bind(model)
        .bind(now_ms())
        .bind(id)
        .bind(&user.id)
        .execute(&mut *tx)
        .await?;
    } else {
        sqlx::query(
            "UPDATE api_credentials SET is_default_enhancement = 1, updated_at = ? WHERE id = ? AND user_id = ?",
        )
        .bind(now_ms())
        .bind(id)
        .bind(&user.id)
        .execute(&mut *tx)
        .await?;
    }
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
    let model = non_empty(body.model).or_else(|| {
        if body.kind.as_deref() == Some("chat") {
            stored
                .as_ref()
                .and_then(|row| non_empty(row.enhancement_model.clone()))
                .or_else(|| {
                    stored
                        .as_ref()
                        .and_then(|row| non_empty(row.default_model.clone()))
                        .filter(|m| !is_transcription_model(m))
                })
                .or_else(|| preset.and_then(|p| p.chat_model).map(str::to_owned))
                .or_else(|| {
                    stored
                        .as_ref()
                        .and_then(|row| non_empty(row.default_model.clone()))
                })
                .or_else(|| preset.and_then(|p| p.model).map(str::to_owned))
        } else {
            stored
                .as_ref()
                .and_then(|row| non_empty(row.transcription_model.clone()))
                .or_else(|| {
                    stored
                        .as_ref()
                        .and_then(|row| non_empty(row.default_model.clone()))
                })
                .or_else(|| {
                    stored
                        .as_ref()
                        .and_then(|row| non_empty(row.enhancement_model.clone()))
                })
                .or_else(|| preset.and_then(|p| p.model).map(str::to_owned))
        }
    });
    let Some(model) = model else {
        return Ok(Json(
            json!({ "ok": false, "kind": "chat", "error": "No model is set." }),
        ));
    };

    let transcription = match body.kind.as_deref() {
        Some("chat") => !can_enhance(&provider) || is_transcription_model(&model),
        Some("transcription" | "audio") => can_transcribe(&provider),
        _ => {
            !can_enhance(&provider)
                || is_transcription_model(&model)
                || (provider == "Google Gemini" && gemini_audio_models().contains(&model.as_str()))
        }
    };
    let kind = if transcription {
        "transcription"
    } else {
        "chat"
    };
    let started = Instant::now();
    let outcome = if provider == "Google Gemini" && transcription {
        gemini_audio_probe(&base, &key, &model).await
    } else if provider == "Google Gemini" {
        gemini_chat_probe(&base, &key, &model).await
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
    if provider == "Google Gemini" {
        let list: &[&str] = if chat {
            &gemini_chat_models()
        } else {
            &gemini_audio_models()
        };
        let models = list
            .iter()
            .map(|id| json!({"id": *id, "name": *id}))
            .collect::<Vec<_>>();
        return Ok(Json(json!({"models": models})));
    }
    if provider == "ElevenLabs" && !chat {
        let models = [
            "scribe_v2",
            "scribe_v2_realtime",
            "scribe_v2_medical",
            "scribe_v1",
        ]
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

async fn gemini_key_probe(key: &str) -> Result<(), Upstream> {
    let req = client()
        .get("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1")
        .header("x-goog-api-key", key);
    call(req, PROBE_TIMEOUT).await.map(|_| ())
}

async fn gemini_chat_probe(base: &str, key: &str, model: &str) -> Result<(), Upstream> {
    let url = crate::ai::gemini_endpoint(base, model, "generateContent");
    let req = client()
        .post(url)
        .header("x-goog-api-key", key)
        .json(&json!({"contents":[{"parts":[{"text":"Reply with OK."}]}],"generationConfig":{"maxOutputTokens":16,"temperature":0}}));
    match call(req, PROBE_TIMEOUT).await {
        Ok(_) => Ok(()),
        Err(Upstream::Refused(400 | 404 | 503)) => gemini_key_probe(key).await,
        Err(e) => Err(e),
    }
}

async fn gemini_audio_probe(base: &str, key: &str, model: &str) -> Result<(), Upstream> {
    if model.contains("transcribe") {
        return gemini_key_probe(key).await;
    }
    let audio = silent_mp3();
    let encoded = base64(&audio);
    let url = crate::ai::gemini_endpoint(base, model, "generateContent");
    let req = client()
        .post(url)
        .header("x-goog-api-key", key)
        .json(&json!({"contents":[{"parts":[{"text":"Transcribe this audio."},{"inlineData":{"mimeType":"audio/mp3","data":encoded}}]}],"generationConfig":{"maxOutputTokens":16,"temperature":0}}));
    match call(req, PROBE_TIMEOUT).await {
        Ok(_) => Ok(()),
        Err(Upstream::Refused(400 | 404 | 503)) => gemini_key_probe(key).await,
        Err(e) => Err(e),
    }
}

fn gemini_audio_models() -> [&'static str; 10] {
    [
        "gemini-3.5-transcribe",
        "gemini-3.8-flash",
        "gemini-3.8-pro",
        "gemini-4-argon",
        "gemini-3.5-flash-lite",
        "gemini-3.6-flash",
        "gemini-2.5-flash",
        "gemini-2.5-pro",
        "gemini-2.5-flash-lite",
        "gemini-2.0-flash",
    ]
}

fn gemini_chat_models() -> [&'static str; 9] {
    [
        "gemini-3.8-flash",
        "gemini-3.8-pro",
        "gemini-4-argon",
        "gemini-3.5-flash-lite",
        "gemini-3.6-flash",
        "gemini-2.5-flash",
        "gemini-2.5-pro",
        "gemini-2.5-flash-lite",
        "gemini-2.0-flash",
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

#[derive(Debug, PartialEq, Eq)]
struct NormalizedModels {
    default_model: Option<String>,
    transcription_model: Option<String>,
    enhancement_model: Option<String>,
    transcription_models: Vec<String>,
    enhancement_models: Vec<String>,
}

fn clean_model_list(list: Option<Vec<String>>) -> Vec<String> {
    let mut out = Vec::new();
    for item in list.unwrap_or_default() {
        let trimmed = item.trim();
        if !trimmed.is_empty() && !out.iter().any(|existing| existing == trimmed) {
            out.push(trimmed.to_owned());
        }
    }
    out
}

fn parse_stored_models(raw: &str) -> Vec<String> {
    clean_model_list(serde_json::from_str::<Vec<String>>(raw).ok())
}

fn normalize_models(
    provider: &str,
    default_model: Option<String>,
    transcription_model: Option<String>,
    enhancement_model: Option<String>,
    transcription_models: Option<Vec<String>>,
    enhancement_models: Option<Vec<String>>,
) -> NormalizedModels {
    let single_model_only = transcription_model.is_none()
        && enhancement_model.is_none()
        && transcription_models.is_none()
        && enhancement_models.is_none();
    let raw_default = non_empty(default_model);
    let mut transcription_model = non_empty(transcription_model);
    let mut enhancement_model = non_empty(enhancement_model);
    let mut transcription_models = clean_model_list(transcription_models);
    let mut enhancement_models = clean_model_list(enhancement_models);

    if single_model_only && let Some(dm) = &raw_default {
        if !can_enhance(provider)
            || is_transcription_model(dm)
            || provider == "Google Gemini"
            || provider == "OpenRouter"
        {
            transcription_model = Some(dm.clone());
            transcription_models = vec![dm.clone()];
        }
        if can_enhance(provider) && !is_transcription_model(dm) {
            enhancement_model = Some(dm.clone());
            enhancement_models = vec![dm.clone()];
        }
    }

    if can_transcribe(provider) {
        if let Some(tm) = &transcription_model {
            if !transcription_models.contains(tm) {
                transcription_models.insert(0, tm.clone());
            }
        } else if !transcription_models.is_empty() {
            transcription_model = Some(transcription_models[0].clone());
        }
    } else {
        transcription_model = None;
        transcription_models.clear();
    }

    if can_enhance(provider) {
        if let Some(em) = &enhancement_model {
            if !enhancement_models.contains(em) {
                enhancement_models.insert(0, em.clone());
            }
        } else if !enhancement_models.is_empty() {
            enhancement_model = Some(enhancement_models[0].clone());
        }
    } else {
        enhancement_model = None;
        enhancement_models.clear();
    }

    let default_model = raw_default
        .or_else(|| transcription_model.clone())
        .or_else(|| enhancement_model.clone());

    NormalizedModels {
        default_model,
        transcription_model,
        enhancement_model,
        transcription_models,
        enhancement_models,
    }
}

fn view(row: &Row) -> Value {
    let mut transcription_models = parse_stored_models(&row.transcription_models);
    let mut enhancement_models = parse_stored_models(&row.enhancement_models);
    let mut transcription_model = non_empty(row.transcription_model.clone())
        .or_else(|| transcription_models.first().cloned());
    let mut enhancement_model =
        non_empty(row.enhancement_model.clone()).or_else(|| enhancement_models.first().cloned());
    if transcription_model.is_none()
        && enhancement_model.is_none()
        && transcription_models.is_empty()
        && enhancement_models.is_empty()
        && row.default_model.is_some()
    {
        let fallback = normalize_models(
            &row.provider,
            row.default_model.clone(),
            None,
            None,
            None,
            None,
        );
        transcription_model = fallback.transcription_model;
        enhancement_model = fallback.enhancement_model;
        transcription_models = fallback.transcription_models;
        enhancement_models = fallback.enhancement_models;
    }
    let default_model = non_empty(row.default_model.clone())
        .or_else(|| transcription_model.clone())
        .or_else(|| enhancement_model.clone());
    json!({
        "id": row.id,
        "provider": row.provider,
        "baseUrl": row.base_url,
        "defaultModel": default_model,
        "transcriptionModel": transcription_model,
        "enhancementModel": enhancement_model,
        "transcriptionModels": transcription_models,
        "enhancementModels": enhancement_models,
        "isDefaultTranscription": row.is_default_transcription,
        "isDefaultEnhancement": row.is_default_enhancement,
        "createdAt": iso(row.created_at),
    })
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty())
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
    sqlx::query_as(
        "SELECT id, provider, api_key, base_url, default_model, \
         transcription_model, enhancement_model, transcription_models, enhancement_models, \
         is_default_transcription, is_default_enhancement, created_at FROM api_credentials WHERE id = ? AND user_id = ?",
    )
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
    if transcription {
        sqlx::query("UPDATE api_credentials SET is_default_transcription = 0 WHERE user_id = ?")
            .bind(user)
            .execute(&mut **tx)
            .await?;
    } else {
        sqlx::query("UPDATE api_credentials SET is_default_enhancement = 0 WHERE user_id = ?")
            .bind(user)
            .execute(&mut **tx)
            .await?;
    }
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

    #[test]
    fn normalize_models_handles_single_and_dual_model_inputs() {
        let gemini_single = normalize_models(
            "Google Gemini",
            Some("gemini-2.0-flash".into()),
            None,
            None,
            None,
            None,
        );
        assert_eq!(
            gemini_single,
            NormalizedModels {
                default_model: Some("gemini-2.0-flash".into()),
                transcription_model: Some("gemini-2.0-flash".into()),
                enhancement_model: Some("gemini-2.0-flash".into()),
                transcription_models: vec!["gemini-2.0-flash".into()],
                enhancement_models: vec!["gemini-2.0-flash".into()],
            }
        );

        let dual = normalize_models(
            "Google Gemini",
            None,
            Some("gemini-3.5-transcribe".into()),
            Some("gemini-2.5-pro".into()),
            Some(vec![
                "gemini-2.5-flash".into(),
                "gemini-3.5-transcribe".into(),
                "gemini-2.5-flash".into(),
            ]),
            Some(vec!["gemini-2.5-flash".into()]),
        );
        assert_eq!(dual.default_model.as_deref(), Some("gemini-3.5-transcribe"));
        assert_eq!(
            dual.transcription_model.as_deref(),
            Some("gemini-3.5-transcribe")
        );
        assert_eq!(
            dual.transcription_models,
            vec!["gemini-2.5-flash", "gemini-3.5-transcribe"]
        );
        assert_eq!(dual.enhancement_model.as_deref(), Some("gemini-2.5-pro"));
        assert_eq!(
            dual.enhancement_models,
            vec!["gemini-2.5-pro", "gemini-2.5-flash"]
        );

        let eleven = normalize_models(
            "ElevenLabs",
            None,
            Some("scribe_v2".into()),
            Some("ignored-chat".into()),
            None,
            Some(vec!["ignored-chat".into()]),
        );
        assert_eq!(eleven.transcription_model.as_deref(), Some("scribe_v2"));
        assert_eq!(eleven.transcription_models, vec!["scribe_v2"]);
        assert!(eleven.enhancement_model.is_none());
        assert!(eleven.enhancement_models.is_empty());

        assert!(gemini_audio_models().contains(&"gemini-3.5-transcribe"));
        assert!(gemini_chat_models().contains(&"gemini-2.5-flash"));
    }
}
