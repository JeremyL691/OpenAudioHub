use axum::Json;
use axum::extract::State;
use serde_json::{Value, json};

use crate::AppState;
use crate::error::{ApiResult, AppError};

/// `{"status":"ok","version":"x.y.z"}`. It also checks that the database answers.
pub async fn get(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    sqlx::query("SELECT 1")
        .execute(&state.db)
        .await
        .map_err(|e| {
            let mut err = AppError::new(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                "DATABASE_UNAVAILABLE",
                "Database unavailable",
            );
            err.source = Some(e.to_string());
            err
        })?;
    Ok(Json(
        json!({ "status": "ok", "version": env!("CARGO_PKG_VERSION") }),
    ))
}
