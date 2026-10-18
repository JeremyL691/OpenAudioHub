//! Transcripts made on the user's device (spec/transcription.md "Browser transcription").
//! The server stores the text; it never calls a provider for these.

use axum::Json;
use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, State};
use serde_json::{Value, json};

use crate::AppState;
use crate::auth::CurrentUser;
use crate::error::{ApiResult, AppError};
use crate::transcribe::{self, Saved, Transcript};

const MAX_TEXT: usize = 200_000;
const MAX_MODEL: usize = 100;
const MAX_LANGUAGE: usize = 10;

pub async fn from_browser(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    body: Result<Json<Value>, JsonRejection>,
) -> ApiResult<Json<Value>> {
    let body = body.map(|Json(v)| v).unwrap_or(Value::Null);
    let field = |name: &str| body.get(name).and_then(Value::as_str).map(str::trim);
    let mut issues = Vec::new();
    let text = field("text").unwrap_or_default();
    if text.is_empty() || text.chars().count() > MAX_TEXT {
        issues.push(json!({ "path": ["text"], "message": "text must be 1 to 200000 characters" }));
    }
    let model = field("model").unwrap_or_default();
    if model.is_empty() || model.chars().count() > MAX_MODEL {
        issues.push(json!({ "path": ["model"], "message": "model must be 1 to 100 characters" }));
    }
    let language = match body.get("detectedLanguage") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if s.trim().chars().count() <= MAX_LANGUAGE => {
            Some(s.trim()).filter(|s| !s.is_empty())
        }
        Some(_) => {
            issues.push(json!({ "path": ["detectedLanguage"], "message": "detectedLanguage must be at most 10 characters" }));
            None
        }
    };
    if !issues.is_empty() {
        return Err(
            AppError::bad_request("MISSING_REQUIRED_FIELD", "Invalid request body")
                .detail("issues", issues),
        );
    }

    let exists: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM recordings WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
    )
    .bind(&id)
    .bind(&user.id)
    .fetch_optional(&state.db)
    .await?;
    if exists.is_none() {
        return Err(AppError::not_found(
            "RECORDING_NOT_FOUND",
            "Recording not found",
        ));
    }

    let transcript = Transcript {
        text: text.to_owned(),
        language: language.map(str::to_owned),
        segments: Vec::new(),
    };
    transcribe::save_transcript(
        &state,
        Saved {
            user_id: &user.id,
            recording_id: &id,
            transcript: &transcript,
            provider: "browser",
            model,
            transcription_type: "browser",
            timeline: None,
        },
    )
    .await?;
    Ok(Json(
        json!({ "transcription": text, "detectedLanguage": language }),
    ))
}
