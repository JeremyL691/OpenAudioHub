//! Sessions, the signed-in user extractor, the origin check, and client addresses.

use std::net::SocketAddr;

use axum::extract::{ConnectInfo, FromRequestParts, Request, State};
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use sha2::{Digest, Sha256};

use crate::db::now_ms;
use crate::error::AppError;
use crate::{AppState, ids};

pub const SESSION_COOKIE: &str = "oah_session";
pub const SESSION_TTL_MS: i64 = 7 * 24 * 3600 * 1000;
/// Sliding expiry: a session used more than a day after it was last extended gets 7 more days.
const SESSION_REFRESH_MS: i64 = 24 * 3600 * 1000;

pub fn sha256_hex(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

/// Creates a session and returns its token (the cookie value). Only the hash is stored.
pub async fn create_session(
    state: &AppState,
    user_id: &str,
    headers: &HeaderMap,
    ip: Option<String>,
) -> Result<String, sqlx::Error> {
    let token = ids::token_hex(32);
    let now = now_ms();
    sqlx::query("DELETE FROM sessions WHERE expires_at < ?")
        .bind(now)
        .execute(&state.db)
        .await?;
    let agent = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok());
    sqlx::query(
        "INSERT INTO sessions (id, user_id, expires_at, ip_address, user_agent, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(sha256_hex(&token))
    .bind(user_id)
    .bind(now + SESSION_TTL_MS)
    .bind(ip)
    .bind(agent)
    .bind(now)
    .bind(now)
    .execute(&state.db)
    .await?;
    Ok(token)
}

pub fn session_cookie(state: &AppState, token: &str) -> HeaderValue {
    let secure = if state.config.app_url.starts_with("https://") {
        "; Secure"
    } else {
        ""
    };
    HeaderValue::from_str(&format!(
        "{SESSION_COOKIE}={token}; Path=/; Max-Age={}; HttpOnly; SameSite=Lax{secure}",
        SESSION_TTL_MS / 1000
    ))
    .expect("cookie built from hex is a valid header")
}

pub fn clear_session_cookie() -> HeaderValue {
    HeaderValue::from_static("oah_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax")
}

pub fn session_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(name, _)| *name == SESSION_COOKIE)
        .map(|(_, value)| value)
        .filter(|value| !value.is_empty())
}

/// The signed-in user. Rejects with 401 when there is no valid session and 403 when suspended.
#[derive(Clone, Debug)]
pub struct CurrentUser {
    pub id: String,
    pub email: String,
    pub name: Option<String>,
    pub session_id: String,
}

#[derive(sqlx::FromRow)]
struct SessionRow {
    session_id: String,
    expires_at: i64,
    updated_at: i64,
    user_id: String,
    email: String,
    name: Option<String>,
    suspended_at: Option<i64>,
}

/// Looks up the session behind a token, extending it when due. `None` for unknown or expired tokens.
pub async fn lookup(
    state: &AppState,
    token: &str,
) -> Result<Option<(CurrentUser, bool)>, sqlx::Error> {
    let now = now_ms();
    let row: Option<SessionRow> = sqlx::query_as(
        "SELECT s.id AS session_id, s.expires_at, s.updated_at, u.id AS user_id, u.email, u.name, u.suspended_at
         FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?",
    )
    .bind(sha256_hex(token))
    .fetch_optional(&state.db)
    .await?;
    let Some(row) = row.filter(|r| r.expires_at > now) else {
        return Ok(None);
    };
    if now - row.updated_at > SESSION_REFRESH_MS {
        sqlx::query("UPDATE sessions SET expires_at = ?, updated_at = ? WHERE id = ?")
            .bind(now + SESSION_TTL_MS)
            .bind(now)
            .bind(&row.session_id)
            .execute(&state.db)
            .await?;
    }
    let user = CurrentUser {
        id: row.user_id,
        email: row.email,
        name: row.name,
        session_id: row.session_id,
    };
    Ok(Some((user, row.suspended_at.is_some())))
}

impl FromRequestParts<AppState> for CurrentUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, AppError> {
        let token = session_token(&parts.headers).ok_or_else(AppError::unauthorized)?;
        match lookup(state, token).await? {
            None => Err(AppError::unauthorized()),
            Some((_, true)) => Err(AppError::new(
                StatusCode::FORBIDDEN,
                "ACCOUNT_SUSPENDED",
                "Account suspended",
            )),
            Some((user, false)) => Ok(user),
        }
    }
}

/// Blocks cross-site writes: a state-changing request that carries the session
/// cookie must send an `Origin` equal to the app's origin.
pub async fn origin_check(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let safe = matches!(
        *request.method(),
        Method::GET | Method::HEAD | Method::OPTIONS
    );
    if safe || session_token(request.headers()).is_none() {
        return next.run(request).await;
    }
    match request
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
    {
        Some(origin) if origin == state.config.app_url => next.run(request).await,
        None | Some("null") => AppError::new(
            StatusCode::FORBIDDEN,
            "MISSING_OR_NULL_ORIGIN",
            "Missing or null Origin",
        )
        .into_response(),
        Some(_) => {
            AppError::new(StatusCode::FORBIDDEN, "INVALID_ORIGIN", "Invalid origin").into_response()
        }
    }
}

/// The client address used for per-client rate limits. Proxy headers count only when the
/// operator says the server sits behind a trusted proxy. Without trust there is no per-client
/// address (`None`), so per-IP checks are skipped and the public API shares one bucket.
pub fn client_ip(
    state: &AppState,
    headers: &HeaderMap,
    peer: Option<&ConnectInfo<SocketAddr>>,
) -> Option<String> {
    if !state.config.trust_proxy_headers {
        return None;
    }
    // A trusted proxy appends the address it saw, so the last entry is the one
    // the client cannot forge.
    let from_header = |name: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(',').next_back())
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty())
    };
    from_header("cf-connecting-ip")
        .or_else(|| from_header("x-real-ip"))
        .or_else(|| from_header("x-forwarded-for"))
        .or_else(|| peer_ip(peer))
}

/// The address recorded on a new session: the client address when trusted, else the TCP peer.
pub fn session_ip(
    state: &AppState,
    headers: &HeaderMap,
    peer: Option<&ConnectInfo<SocketAddr>>,
) -> Option<String> {
    client_ip(state, headers, peer).or_else(|| peer_ip(peer))
}

fn peer_ip(peer: Option<&ConnectInfo<SocketAddr>>) -> Option<String> {
    peer.map(|ConnectInfo(addr)| addr.ip().to_string())
}

/// A 429 in the common error shape with the standard rate-limit headers.
pub fn too_many(decision: &crate::ratelimit::Decision, now: i64) -> AppError {
    let wait = ((decision.reset_at - now + 999) / 1000).max(1);
    AppError::new(
        StatusCode::TOO_MANY_REQUESTS,
        "RATE_LIMITED",
        format!("Too many attempts. Please wait {wait}s and try again."),
    )
    .detail("retryAfter", wait)
    .header("retry-after", wait.to_string())
    .header("x-ratelimit-limit", decision.limit.to_string())
    .header("x-ratelimit-remaining", decision.remaining.to_string())
    .header("x-ratelimit-reset", (decision.reset_at / 1000).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::db;

    async fn state(trust_proxy_headers: bool) -> AppState {
        let dir = tempfile::tempdir().unwrap();
        let mut config = Config::for_tests(dir.path());
        config.trust_proxy_headers = trust_proxy_headers;
        AppState::new(config, db::open_memory().await.unwrap())
    }

    fn forwarded() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", HeaderValue::from_static("203.0.113.9"));
        headers
    }

    #[tokio::test]
    async fn untrusted_proxy_headers_give_no_rate_limit_address() {
        let state = state(false).await;
        let peer = ConnectInfo("198.51.100.7:4000".parse::<SocketAddr>().unwrap());
        // No per-client address, so per-IP limits are skipped and the public API uses one bucket.
        assert_eq!(client_ip(&state, &forwarded(), Some(&peer)), None);
        // The session still records the peer address, as before.
        assert_eq!(
            session_ip(&state, &forwarded(), Some(&peer)).as_deref(),
            Some("198.51.100.7")
        );
    }

    #[tokio::test]
    async fn trusted_proxy_headers_give_the_forwarded_client() {
        let state = state(true).await;
        let peer = ConnectInfo("198.51.100.7:4000".parse::<SocketAddr>().unwrap());
        assert_eq!(
            client_ip(&state, &forwarded(), Some(&peer)).as_deref(),
            Some("203.0.113.9")
        );
        // Without a proxy header, the peer is the fallback.
        assert_eq!(
            client_ip(&state, &HeaderMap::new(), Some(&peer)).as_deref(),
            Some("198.51.100.7")
        );
    }
}
