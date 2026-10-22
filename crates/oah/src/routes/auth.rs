//! `/api/auth/*` and the desktop session exchange (spec/auth.md).

use std::net::SocketAddr;

use axum::extract::{ConnectInfo, Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};
use subtle::ConstantTimeEq;

use crate::auth::{self, clear_session_cookie, session_cookie, sha256_hex};
use crate::crypto;
use crate::db::now_ms;
use crate::error::{ApiResult, AppError};
use crate::notify;
use crate::time::iso;
use crate::{AppState, ids};

const MINUTE_MS: i64 = 60_000;
/// Reset tokens live in `verifications`, keyed by this prefix plus the user id.
const RESET_PREFIX: &str = "password-reset:";
const RESET_TTL_MS: i64 = 60 * MINUTE_MS;
const DEFAULT_CALLBACK: &str = "/reset-password";
const RESET_SENT: &str = "If this email exists in our system, check your email for the reset link";
/// Longest password accepted anywhere (sign-up, sign-in, reset), in bytes.
const MAX_PASSWORD_BYTES: usize = 256;
static UNKNOWN_USER_HASH: std::sync::OnceLock<String> = std::sync::OnceLock::new();

#[derive(sqlx::FromRow)]
pub struct UserRow {
    pub id: String,
    pub email: String,
    pub name: Option<String>,
    pub email_verified: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

impl UserRow {
    pub fn json(&self) -> Value {
        json!({
            "id": self.id,
            "name": self.name,
            "email": self.email,
            "emailVerified": self.email_verified,
            "createdAt": iso(self.created_at),
            "updatedAt": iso(self.updated_at),
        })
    }
}

const USER_COLUMNS: &str = "id, email, name, email_verified, created_at, updated_at";

async fn user_by_id(state: &AppState, id: &str) -> Result<Option<UserRow>, sqlx::Error> {
    sqlx::query_as(&format!("SELECT {USER_COLUMNS} FROM users WHERE id = ?"))
        .bind(id)
        .fetch_optional(&state.db)
        .await
}

fn limit(state: &AppState, name: &str, ip: &str, max: u32) -> ApiResult<()> {
    let now = now_ms();
    let decision = state
        .limiter
        .hit(&format!("{name}:{ip}"), max, MINUTE_MS, now);
    if decision.allowed {
        Ok(())
    } else {
        Err(auth::too_many(&decision, now))
    }
}

fn signed_in(state: &AppState, token: &str, status: StatusCode, body: Value) -> Response {
    (
        status,
        [(header::SET_COOKIE, session_cookie(state, token))],
        Json(body),
    )
        .into_response()
}

fn valid_email(email: &str) -> bool {
    let Some((local, domain)) = email.split_once('@') else {
        return false;
    };
    !local.is_empty()
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && !email.contains(char::is_whitespace)
        && email.len() <= 254
}

#[derive(Deserialize)]
pub struct SignUp {
    name: Option<String>,
    email: Option<String>,
    password: Option<String>,
}

pub async fn sign_up(
    State(state): State<AppState>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: HeaderMap,
    Json(body): Json<SignUp>,
) -> ApiResult<Response> {
    let peer = peer.as_ref().map(|Extension(p)| p);
    let ip = auth::client_ip(&state, &headers, peer);
    limit(&state, "sign-up", &ip, 5)?;
    if state.config.disable_registration || state.config.desktop.is_some() {
        return Err(AppError::new(
            StatusCode::FORBIDDEN,
            "REGISTRATION_DISABLED",
            "Registration is disabled",
        ));
    }
    let name = body
        .name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty());
    let email = body
        .email
        .as_deref()
        .map(|e| e.trim().to_lowercase())
        .filter(|e| valid_email(e));
    let (Some(name), Some(email)) = (name, email) else {
        return Err(AppError::bad_request(
            "VALIDATION_ERROR",
            "Name and a valid email are required",
        ));
    };
    let password = body.password.unwrap_or_default();
    if password.chars().count() < 8 {
        return Err(AppError::bad_request(
            "PASSWORD_TOO_SHORT",
            "Password must be at least 8 characters",
        ));
    }
    if password.len() > MAX_PASSWORD_BYTES {
        return Err(AppError::bad_request(
            "PASSWORD_TOO_LONG",
            "Password must be at most 256 bytes",
        ));
    }
    let hash = tokio::task::spawn_blocking(move || crypto::hash_password(&password))
        .await
        .map_err(AppError::internal)?;
    let now = now_ms();
    let user = UserRow {
        id: ids::new_id(),
        email,
        name: Some(name.to_owned()),
        email_verified: false,
        created_at: now,
        updated_at: now,
    };
    let mut tx = crate::db::begin_write(&state.db).await?;
    let inserted = sqlx::query("INSERT INTO users (id, email, name, email_verified, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?) ON CONFLICT (email) DO NOTHING")
        .bind(&user.id)
        .bind(&user.email)
        .bind(&user.name)
        .bind(now)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    if inserted.rows_affected() == 0 {
        return Err(AppError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
            "An account with this email already exists",
        ));
    }
    sqlx::query("INSERT INTO credentials (user_id, password_hash, updated_at) VALUES (?, ?, ?)")
        .bind(&user.id)
        .bind(&hash)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    let token = auth::create_session(
        &state,
        &user.id,
        &headers,
        auth::session_ip(&state, &headers, peer),
    )
    .await?;
    Ok(signed_in(
        &state,
        &token,
        StatusCode::OK,
        json!({ "user": user.json() }),
    ))
}

#[derive(Deserialize)]
pub struct SignIn {
    email: Option<String>,
    password: Option<String>,
}

pub async fn sign_in(
    State(state): State<AppState>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: HeaderMap,
    Json(body): Json<SignIn>,
) -> ApiResult<Response> {
    let peer = peer.as_ref().map(|Extension(p)| p);
    let ip = auth::client_ip(&state, &headers, peer);
    limit(&state, "sign-in", &ip, 10)?;
    let (Some(email), Some(password)) = (body.email, body.password) else {
        return Err(AppError::bad_request(
            "VALIDATION_ERROR",
            "Email and password are required",
        ));
    };
    let email = email.trim().to_lowercase();
    // An over-long password can never match, so it takes the same path as an unknown email:
    // no lookup, a dummy hash check, and the same error as any bad credential.
    let row: Option<(String, String)> = if password.len() > MAX_PASSWORD_BYTES {
        None
    } else {
        sqlx::query_as(
            "SELECT u.id, c.password_hash FROM users u JOIN credentials c ON c.user_id = u.id WHERE u.email = ?",
        )
        .bind(&email)
        .fetch_optional(&state.db)
        .await?
    };
    let invalid = || {
        AppError::new(
            StatusCode::UNAUTHORIZED,
            "INVALID_EMAIL_OR_PASSWORD",
            "Invalid email or password",
        )
    };
    let Some((user_id, hash)) = row else {
        // Hash anyway, so an unknown email takes as long as a wrong password.
        tokio::task::spawn_blocking(move || {
            crypto::verify_password(
                UNKNOWN_USER_HASH.get_or_init(|| crypto::hash_password("x")),
                &password,
            )
        })
        .await
        .map_err(AppError::internal)?;
        return Err(invalid());
    };
    let (ok, new_hash) = tokio::task::spawn_blocking(move || {
        let ok = crypto::verify_password(&hash, &password);
        (
            ok,
            (ok && crypto::needs_rehash(&hash)).then(|| crypto::hash_password(&password)),
        )
    })
    .await
    .map_err(AppError::internal)?;
    if !ok {
        return Err(invalid());
    }
    if let Some(new_hash) = new_hash {
        sqlx::query("UPDATE credentials SET password_hash = ?, updated_at = ? WHERE user_id = ?")
            .bind(new_hash)
            .bind(now_ms())
            .bind(&user_id)
            .execute(&state.db)
            .await?;
    }
    let user = user_by_id(&state, &user_id).await?.ok_or_else(invalid)?;
    let token = auth::create_session(
        &state,
        &user_id,
        &headers,
        auth::session_ip(&state, &headers, peer),
    )
    .await?;
    Ok(signed_in(
        &state,
        &token,
        StatusCode::OK,
        json!({ "redirect": false, "user": user.json() }),
    ))
}

/// The current session and user, or `null`. Never an error.
pub async fn get_session(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    let Some(token) = auth::session_token(&headers) else {
        return Ok(Json(Value::Null));
    };
    let Some((current, _)) = auth::lookup(&state, token).await? else {
        return Ok(Json(Value::Null));
    };
    let session: Option<(i64, i64)> =
        sqlx::query_as("SELECT expires_at, created_at FROM sessions WHERE id = ?")
            .bind(&current.session_id)
            .fetch_optional(&state.db)
            .await?;
    let (Some((expires_at, created_at)), Some(user)) =
        (session, user_by_id(&state, &current.id).await?)
    else {
        return Ok(Json(Value::Null));
    };
    Ok(Json(json!({
        "session": { "userId": user.id, "expiresAt": iso(expires_at), "createdAt": iso(created_at) },
        "user": user.json(),
    })))
}

pub async fn sign_out(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    if let Some(token) = auth::session_token(&headers) {
        sqlx::query("DELETE FROM sessions WHERE id = ?")
            .bind(sha256_hex(token))
            .execute(&state.db)
            .await?;
    }
    Ok((
        [(header::SET_COOKIE, clear_session_cookie())],
        Json(json!({ "success": true })),
    )
        .into_response())
}

/// Desktop only: trades the per-launch secret for a session of the local account.
pub async fn desktop_session(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let Some(desktop) = &state.config.desktop else {
        return Err(AppError::not_found("NOT_FOUND", "Not found"));
    };
    let expected_host = state.config.app_url.split("://").nth(1).unwrap_or_default();
    if headers.get(header::HOST).and_then(|h| h.to_str().ok()) != Some(expected_host) {
        return Err(AppError::new(
            StatusCode::FORBIDDEN,
            "INVALID_HOST",
            "Invalid host",
        ));
    }
    let given = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or_default();
    let matches: bool = sha256_hex(given)
        .as_bytes()
        .ct_eq(sha256_hex(&desktop.launch_secret).as_bytes())
        .into();
    if !matches {
        return Err(AppError::unauthorized());
    }
    let user_id = desktop_user(&state, desktop.user_id.as_deref()).await?;
    let token = auth::create_session(&state, &user_id, &headers, None).await?;
    Ok((
        StatusCode::NO_CONTENT,
        [(header::SET_COOKIE, session_cookie(&state, &token))],
    )
        .into_response())
}

#[derive(Deserialize)]
pub struct CodeQuery {
    code: Option<String>,
}

/// Desktop only: the app window opens `/api/desktop/session?code=<launch secret>` once at start.
/// The code works a single time; the answer sets the session cookie and opens the dashboard.
pub async fn desktop_session_link(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Query(query): axum::extract::Query<CodeQuery>,
) -> ApiResult<Response> {
    let Some(desktop) = &state.config.desktop else {
        return Err(AppError::not_found("NOT_FOUND", "Not found"));
    };
    let given = query.code.unwrap_or_default();
    let matches: bool = sha256_hex(&given)
        .as_bytes()
        .ct_eq(sha256_hex(&desktop.launch_secret).as_bytes())
        .into();
    if !matches
        || state
            .desktop_code_used
            .swap(true, std::sync::atomic::Ordering::SeqCst)
    {
        return Err(AppError::unauthorized());
    }
    let user_id = desktop_user(&state, desktop.user_id.as_deref()).await?;
    let token = auth::create_session(&state, &user_id, &headers, None).await?;
    Ok((
        StatusCode::SEE_OTHER,
        [
            (header::SET_COOKIE, session_cookie(&state, &token)),
            (
                header::LOCATION,
                axum::http::HeaderValue::from_static("/dashboard"),
            ),
        ],
    )
        .into_response())
}

/// The configured user, else the earliest user, else a new local account.
async fn desktop_user(state: &AppState, configured: Option<&str>) -> ApiResult<String> {
    if let Some(id) = configured {
        return user_by_id(state, id)
            .await?
            .map(|u| u.id)
            .ok_or_else(|| AppError::internal("OAH_DESKTOP_USER_ID does not exist"));
    }
    let now = now_ms();
    // The unique email makes concurrent first launches create one account.
    sqlx::query(
        "INSERT INTO users (id, email, name, email_verified, created_at, updated_at)
         SELECT ?, 'local@openaudiohub.localhost', 'Local user', 1, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users)
         ON CONFLICT (email) DO NOTHING",
    )
    .bind(ids::new_id())
    .bind(now)
    .bind(now)
    .execute(&state.db)
    .await?;
    let (id,): (String,) = sqlx::query_as("SELECT id FROM users ORDER BY created_at, id LIMIT 1")
        .fetch_one(&state.db)
        .await?;
    Ok(id)
}

/// Password reset by email (spec/auth.md). Mounted by `routes::router`.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/auth/config", get(public_config))
        .route(
            "/api/auth/request-password-reset",
            post(|state, peer, headers, body| async move {
                request_password_reset(state, peer, headers, body)
                    .await
                    .map_err(AppError::with_message_field)
            }),
        )
        .route(
            "/api/auth/reset-password/{token}",
            get(|state, peer, headers, path, query| async move {
                reset_password_link(state, peer, headers, path, query)
                    .await
                    .map_err(AppError::with_message_field)
            }),
        )
        .route(
            "/api/auth/reset-password",
            post(|state, peer, headers, body| async move {
                reset_password(state, peer, headers, body)
                    .await
                    .map_err(AppError::with_message_field)
            }),
        )
}

#[derive(Deserialize)]
pub struct ResetRequest {
    email: Option<String>,
    #[serde(rename = "redirectTo")]
    redirect_to: Option<String>,
}

/// Same answer whether or not the account exists. The mail (when SMTP is set) goes out in the background.
pub async fn request_password_reset(
    State(state): State<AppState>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: HeaderMap,
    Json(body): Json<ResetRequest>,
) -> ApiResult<Json<Value>> {
    let ip = auth::client_ip(&state, &headers, peer.as_ref().map(|Extension(p)| p));
    limit(&state, "request-password-reset", &ip, 3)?;
    let email = body
        .email
        .as_deref()
        .map(|e| e.trim().to_lowercase())
        .unwrap_or_default();
    if !valid_email(&email) {
        return Err(AppError::bad_request(
            "VALIDATION_ERROR",
            "A valid email is required",
        ));
    }
    // Counts every request for this address, known or not.
    let now = now_ms();
    let decision = state
        .limiter
        .hit(&format!("reset-email:{email}"), 3, MINUTE_MS, now);
    if !decision.allowed {
        return Err(auth::too_many(&decision, now));
    }
    if state.config.smtp.configured() {
        let callback = callback_url(body.redirect_to.as_deref());
        let worker = state.clone();
        tokio::spawn(async move {
            if let Err(error) = issue_reset(&worker, &email, &callback).await {
                tracing::warn!(code = error.code, "password reset email not prepared");
            }
        });
    }
    Ok(Json(json!({ "status": true, "message": RESET_SENT })))
}

/// Creates a reset token for the account with this email and sends the link. Unknown emails do nothing.
async fn issue_reset(state: &AppState, email: &str, callback: &str) -> ApiResult<()> {
    let row: Option<(String,)> = sqlx::query_as("SELECT id FROM users WHERE email = ?")
        .bind(email)
        .fetch_optional(&state.db)
        .await?;
    let Some((user_id,)) = row else {
        return Ok(());
    };
    let token = create_reset_token(state, &user_id).await?;
    let link = format!(
        "{}/api/auth/reset-password/{token}?callbackURL={}",
        state.config.app_url,
        encode_query(callback)
    );
    notify::send_soft(&state.config, email, &notify::reset_password_email(&link)).await;
    Ok(())
}

/// Stores a new one-time token (hashed) valid for one hour and returns the token itself.
async fn create_reset_token(state: &AppState, user_id: &str) -> ApiResult<String> {
    let token = ids::token_hex(32);
    let now = now_ms();
    sqlx::query(
        "INSERT INTO verifications (id, identifier, value, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(ids::new_id())
    .bind(format!("{RESET_PREFIX}{user_id}"))
    .bind(sha256_hex(&token))
    .bind(now + RESET_TTL_MS)
    .bind(now)
    .execute(&state.db)
    .await?;
    Ok(token)
}

/// The user id behind a live reset token, or `None` for unknown, used or expired tokens.
async fn live_reset_user(state: &AppState, token: &str) -> Result<Option<String>, sqlx::Error> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT identifier FROM verifications WHERE value = ? AND expires_at > ?")
            .bind(sha256_hex(token))
            .bind(now_ms())
            .fetch_optional(&state.db)
            .await?;
    Ok(row.and_then(|(identifier,)| identifier.strip_prefix(RESET_PREFIX).map(str::to_owned)))
}

/// Only same-site paths are accepted as callbacks, so the reset link cannot bounce to another site.
fn callback_url(requested: Option<&str>) -> String {
    match requested {
        Some(path)
            if path.starts_with('/')
                && !path.starts_with("//")
                && !path.contains('\\')
                && !path.chars().any(char::is_control) =>
        {
            path.to_owned()
        }
        _ => DEFAULT_CALLBACK.to_owned(),
    }
}

fn encode_query(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn with_query(path: &str, pair: &str) -> String {
    let sep = if path.contains('?') { '&' } else { '?' };
    format!("{path}{sep}{pair}")
}

#[derive(Deserialize)]
pub struct CallbackQuery {
    #[serde(rename = "callbackURL")]
    callback_url: Option<String>,
}

/// The link in the reset email. A live token goes to the callback with `?token=`, anything else with `?error=INVALID_TOKEN`.
pub async fn reset_password_link(
    State(state): State<AppState>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: HeaderMap,
    Path(token): Path<String>,
    Query(query): Query<CallbackQuery>,
) -> ApiResult<Response> {
    let ip = auth::client_ip(&state, &headers, peer.as_ref().map(|Extension(p)| p));
    limit(&state, "reset-link", &ip, 10)?;
    let callback = callback_url(query.callback_url.as_deref());
    let location = if live_reset_user(&state, &token).await?.is_some() {
        with_query(&callback, &format!("token={token}"))
    } else {
        with_query(&callback, "error=INVALID_TOKEN")
    };
    Ok((StatusCode::FOUND, [(header::LOCATION, location)]).into_response())
}

#[derive(Deserialize)]
pub struct ResetBody {
    #[serde(rename = "newPassword")]
    new_password: Option<String>,
    token: Option<String>,
}

/// Sets the new password. The token is used up in the same transaction, and every session of the account ends.
pub async fn reset_password(
    State(state): State<AppState>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: HeaderMap,
    Json(body): Json<ResetBody>,
) -> ApiResult<Json<Value>> {
    let ip = auth::client_ip(&state, &headers, peer.as_ref().map(|Extension(p)| p));
    limit(&state, "reset-password", &ip, 10)?;
    let Some(password) = body.new_password else {
        return Err(AppError::bad_request(
            "VALIDATION_ERROR",
            "New password is required",
        ));
    };
    if password.chars().count() < 8 {
        return Err(AppError::bad_request(
            "PASSWORD_TOO_SHORT",
            "Password must be at least 8 characters",
        ));
    }
    if password.len() > MAX_PASSWORD_BYTES {
        return Err(AppError::bad_request(
            "PASSWORD_TOO_LONG",
            "Password must be at most 256 bytes",
        ));
    }
    let Some(token) = body.token.filter(|t| !t.is_empty()) else {
        return Err(AppError::bad_request(
            "VALIDATION_ERROR",
            "Token is required",
        ));
    };
    let invalid = || AppError::bad_request("INVALID_TOKEN", "Invalid token");
    if live_reset_user(&state, &token).await?.is_none() {
        return Err(invalid());
    }
    let hash = tokio::task::spawn_blocking(move || crypto::hash_password(&password))
        .await
        .map_err(AppError::internal)?;
    let now = now_ms();
    let mut tx = crate::db::begin_write(&state.db).await?;
    // Deleting and returning in one statement makes the token single use.
    let used: Option<String> = sqlx::query_scalar(
        "DELETE FROM verifications WHERE value = ? AND expires_at > ? RETURNING identifier",
    )
    .bind(sha256_hex(&token))
    .bind(now)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(user_id) = used.and_then(|id| id.strip_prefix(RESET_PREFIX).map(str::to_owned)) else {
        return Err(invalid());
    };
    sqlx::query(
        "INSERT INTO credentials (user_id, password_hash, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET password_hash = excluded.password_hash, updated_at = excluded.updated_at",
    )
    .bind(&user_id)
    .bind(&hash)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM sessions WHERE user_id = ?")
        .bind(&user_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(json!({ "status": true })))
}

/// What the sign-in pages need to know about this server. A server-rendered page can know it directly.
async fn public_config(State(state): State<AppState>) -> Json<Value> {
    Json(json!({
        "registrationEnabled": !state.config.disable_registration && state.config.desktop.is_none(),
        "passwordResetEnabled": state.config.smtp.configured(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::db;

    async fn state_with_user(dir: &std::path::Path) -> (AppState, String) {
        let state = AppState::new(Config::for_tests(dir), db::open_memory().await.unwrap());
        let now = now_ms();
        sqlx::query("INSERT INTO users (id, email, name, email_verified, created_at, updated_at) VALUES ('u1', 'reset@example.com', 'R', 0, ?, ?)")
            .bind(now)
            .bind(now)
            .execute(&state.db)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO credentials (user_id, password_hash, updated_at) VALUES ('u1', ?, ?)",
        )
        .bind(crypto::hash_password("old-password-1"))
        .bind(now)
        .execute(&state.db)
        .await
        .unwrap();
        let token = create_reset_token(&state, "u1").await.unwrap();
        (state, token)
    }

    #[test]
    fn callback_must_be_a_same_site_path() {
        assert_eq!(callback_url(Some("/reset-password")), "/reset-password");
        assert_eq!(callback_url(Some("//evil.example")), DEFAULT_CALLBACK);
        assert_eq!(callback_url(Some("https://evil.example")), DEFAULT_CALLBACK);
        assert_eq!(callback_url(None), DEFAULT_CALLBACK);
    }

    #[test]
    fn query_values_are_encoded() {
        assert_eq!(
            encode_query("/reset-password?x=1&y"),
            "/reset-password%3Fx%3D1%26y"
        );
    }

    #[tokio::test]
    async fn reset_token_is_hashed_and_single_use() {
        let dir = tempfile::tempdir().unwrap();
        let (state, token) = state_with_user(dir.path()).await;
        let stored: Vec<(String,)> = sqlx::query_as("SELECT value FROM verifications")
            .fetch_all(&state.db)
            .await
            .unwrap();
        assert_eq!(stored.len(), 1);
        assert_ne!(stored[0].0, token, "token must not be stored as-is");
        assert_eq!(
            live_reset_user(&state, &token).await.unwrap().as_deref(),
            Some("u1")
        );

        let body = |password: &str| ResetBody {
            new_password: Some(password.into()),
            token: Some(token.clone()),
        };
        let ok = reset_password(
            State(state.clone()),
            None,
            HeaderMap::new(),
            Json(body("brand-new-pass")),
        )
        .await;
        assert!(ok.is_ok());
        // Second use of the same token fails.
        let again = reset_password(
            State(state.clone()),
            None,
            HeaderMap::new(),
            Json(body("another-pass-2")),
        )
        .await;
        assert_eq!(again.unwrap_err().code, "INVALID_TOKEN");
        // The new password signs in; the old one no longer does.
        let hash: (String,) =
            sqlx::query_as("SELECT password_hash FROM credentials WHERE user_id = 'u1'")
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert!(crypto::verify_password(&hash.0, "brand-new-pass"));
        assert!(!crypto::verify_password(&hash.0, "old-password-1"));
    }

    #[tokio::test]
    async fn short_password_is_checked_before_the_token() {
        let dir = tempfile::tempdir().unwrap();
        let (state, _token) = state_with_user(dir.path()).await;
        let body = ResetBody {
            new_password: Some("short".into()),
            token: Some("not-a-token".into()),
        };
        let error = reset_password(State(state), None, HeaderMap::new(), Json(body))
            .await
            .unwrap_err();
        assert_eq!(error.code, "PASSWORD_TOO_SHORT");
    }

    #[tokio::test]
    async fn over_long_sign_in_password_is_a_bad_credential() {
        let dir = tempfile::tempdir().unwrap();
        let (state, _token) = state_with_user(dir.path()).await;
        let body = SignIn {
            email: Some("reset@example.com".into()),
            password: Some("x".repeat(MAX_PASSWORD_BYTES + 1)),
        };
        let error = sign_in(State(state), None, HeaderMap::new(), Json(body))
            .await
            .unwrap_err();
        assert_eq!(error.code, "INVALID_EMAIL_OR_PASSWORD");
    }

    #[tokio::test]
    async fn expired_token_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let (state, token) = state_with_user(dir.path()).await;
        sqlx::query("UPDATE verifications SET expires_at = 0")
            .execute(&state.db)
            .await
            .unwrap();
        assert!(live_reset_user(&state, &token).await.unwrap().is_none());
    }
}
