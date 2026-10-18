//! The one error shape every API route returns:
//! `{"error": "...", "code": "SCREAMING_SNAKE", "details": {...}}`.
//! 5xx responses carry `details.errorId` (`err_` + 8 hex), which is also logged.

use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use rand::RngCore;
use serde_json::{Map, Value, json};

#[derive(Debug, Clone)]
pub struct AppError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
    pub details: Map<String, Value>,
    pub headers: Vec<(&'static str, String)>,
    /// Logged for 5xx; never sent to the client.
    pub source: Option<String>,
    /// Also send the text as `message` (the password reset routes answer with it too).
    pub echo_message: bool,
}

pub type ApiResult<T> = Result<T, AppError>;

impl AppError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            details: Map::new(),
            headers: Vec::new(),
            source: None,
            echo_message: false,
        }
    }

    pub fn detail(mut self, key: &str, value: impl Into<Value>) -> Self {
        self.details.insert(key.to_owned(), value.into());
        self
    }

    pub fn header(mut self, name: &'static str, value: String) -> Self {
        self.headers.push((name, value));
        self
    }

    pub fn with_message_field(mut self) -> Self {
        self.echo_message = true;
        self
    }

    pub fn bad_request(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, code, message)
    }

    pub fn not_found(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, code, message)
    }

    pub fn unauthorized() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            "AUTH_SESSION_MISSING",
            "Unauthorized",
        )
    }

    /// An unexpected failure. The cause goes to the log only.
    pub fn internal(cause: impl std::fmt::Display) -> Self {
        let mut e = Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "INTERNAL_ERROR",
            "Something went wrong",
        );
        e.source = Some(cause.to_string());
        e
    }
}

impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        Self::internal(e)
    }
}

impl IntoResponse for AppError {
    fn into_response(mut self) -> Response {
        if self.status.is_server_error() {
            let mut id = [0u8; 4];
            rand::rng().fill_bytes(&mut id);
            let error_id = format!("err_{}", hex::encode(id));
            tracing::error!(
                error_id,
                code = self.code,
                cause = self.source.as_deref().unwrap_or(""),
                "{}",
                self.message
            );
            self.details.insert("errorId".into(), error_id.into());
        }
        let mut body = json!({ "error": self.message, "code": self.code });
        if self.echo_message {
            body["message"] = Value::String(self.message.clone());
        }
        if !self.details.is_empty() {
            body["details"] = Value::Object(self.details);
        }
        let mut response = (self.status, Json(body)).into_response();
        for (name, value) in self.headers {
            if let Ok(value) = axum::http::HeaderValue::from_str(&value) {
                response.headers_mut().insert(name, value);
            }
        }
        response
    }
}
