//! Connection status, disconnect, the sign-in flows, and the browser handoff (spec/plaud.md).

use axum::Json;
use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Html;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use super::api::{Client, Device, PlaudError};
use super::token;
use crate::auth::CurrentUser;
use crate::db::now_ms;
use crate::error::{ApiResult, AppError};
use crate::time::iso;
use crate::{AppState, ids};

const HANDOFF_TTL_MS: i64 = 10 * 60_000;
/// A user keeps at most this many live handoff codes.
const HANDOFF_KEEP: i64 = 5;

pub(super) const CONN_SQL: &str = "SELECT bearer_token, api_base, plaud_email, workspace_id, invalidated_at, created_at, updated_at \
    FROM plaud_connections WHERE user_id = ?";

#[derive(sqlx::FromRow)]
pub(super) struct ConnRow {
    pub bearer_token: String,
    pub api_base: String,
    pub plaud_email: Option<String>,
    pub workspace_id: Option<String>,
    pub invalidated_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SendCodeBody {
    email: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct VerifyBody {
    code: Option<String>,
    otp_token: Option<String>,
    api_base: Option<String>,
    email: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ConnectTokenBody {
    access_token: Option<String>,
    api_base: Option<String>,
    source: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CompleteBody {
    code: Option<String>,
    access_token: Option<String>,
    api_base: Option<String>,
}

#[derive(Deserialize)]
pub struct CodeQuery {
    code: Option<String>,
}

/// A body that is not valid JSON counts as empty, so its fields report as missing.
fn body<T: DeserializeOwned + Default>(bytes: &[u8]) -> T {
    serde_json::from_slice(bytes).unwrap_or_default()
}

fn present(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty())
}

fn missing(field: &str) -> AppError {
    AppError::bad_request("MISSING_REQUIRED_FIELD", format!("{field} is required"))
        .detail("field", field)
}

/// Maps a Plaud failure to the error a sign-in call returns.
fn generic(e: PlaudError) -> AppError {
    match e {
        PlaudError::Rejected { message } => AppError::new(
            StatusCode::UNAUTHORIZED,
            "PLAUD_INVALID_TOKEN",
            "Plaud rejected the token.",
        )
        .detail("plaudStatus", 401)
        .detail("plaudMessage", message),
        PlaudError::RateLimited { retry_after } => AppError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "PLAUD_RATE_LIMITED",
            "Plaud is rate limiting requests. Try again later.",
        )
        .detail("retryAfter", retry_after.unwrap_or(1)),
        PlaudError::Upstream => AppError::new(
            StatusCode::BAD_GATEWAY,
            "PLAUD_UPSTREAM_ERROR",
            "Plaud is temporarily unavailable. Please try again later.",
        ),
        PlaudError::Api { status, message } => {
            AppError::bad_request("PLAUD_API_ERROR", message).detail("plaudStatus", status)
        }
    }
}

fn allowed(state: &AppState, raw: &str) -> ApiResult<String> {
    token::allowed_base(state.config.plaud_api_base.as_deref(), raw).ok_or_else(|| {
        AppError::bad_request(
            "PLAUD_INVALID_API_BASE",
            "That Plaud API address is not allowed.",
        )
    })
}

/// The requested base when given (and allowed), otherwise the default base.
fn base_or_default(state: &AppState, raw: Option<String>) -> ApiResult<String> {
    match present(raw) {
        Some(raw) => allowed(state, &raw),
        None => Ok(state
            .config
            .plaud_api_base
            .clone()
            .unwrap_or_else(|| token::GLOBAL_BASE.to_owned())),
    }
}

/// The checks every paste and handoff runs before any Plaud call. Returns the trimmed token.
fn check_token(raw: Option<String>) -> ApiResult<String> {
    let raw = present(raw).ok_or_else(|| missing("accessToken"))?;
    let t = raw.strip_prefix("Bearer ").unwrap_or(&raw).trim();
    if t.is_empty() {
        return Err(missing("accessToken"));
    }
    if t.split('.').count() != 3 {
        return Err(AppError::bad_request(
            "INVALID_INPUT",
            "Copy the account token from the Plaud web app. It has three parts separated by dots.",
        )
        .detail("field", "accessToken"));
    }
    let claims = token::claims(t);
    if claims.as_ref().is_some_and(token::is_workspace) {
        return Err(AppError::bad_request(
            "PLAUD_WORKSPACE_TOKEN_PASTED",
            "This is a workspace token. Copy the account token from the Plaud account cookie instead.",
        ));
    }
    if claims
        .as_ref()
        .and_then(token::expires_at_ms)
        .is_some_and(|exp| exp <= now_ms())
    {
        return Err(AppError::bad_request(
            "PLAUD_INVALID_TOKEN",
            "This Plaud token has expired. Sign in to Plaud again and copy a new token.",
        ));
    }
    Ok(t.to_owned())
}

/// Validates the token against Plaud, then saves the connection and its devices in one transaction.
/// The stored token is the account token; a workspace token is only used for the check.
pub(super) async fn connect(
    state: &AppState,
    user_id: &str,
    token: &str,
    base: &str,
    email: Option<String>,
) -> ApiResult<Vec<Device>> {
    let account = Client::new(base, token);
    let workspace = account.personal_workspace().await.ok().flatten();
    let checker = match &workspace {
        Some(ws) => match account.workspace_token(ws).await {
            Ok(wt) => Client::new(base, &wt),
            Err(PlaudError::Api { status, message }) => {
                return Err(
                    AppError::bad_request("PLAUD_WORKSPACE_UNAVAILABLE", message)
                        .detail("plaudStatus", status),
                );
            }
            Err(e) => return Err(generic(e)),
        },
        None => account,
    };
    let devices = checker.devices().await.map_err(generic)?;

    let now = now_ms();
    let mut tx = state.db.begin().await?;
    sqlx::query(
        "INSERT INTO plaud_connections (id, user_id, bearer_token, api_base, plaud_email, workspace_id, invalidated_at, last_sync, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?) \
         ON CONFLICT (user_id) DO UPDATE SET bearer_token = excluded.bearer_token, api_base = excluded.api_base, \
         plaud_email = excluded.plaud_email, workspace_id = excluded.workspace_id, invalidated_at = NULL, updated_at = excluded.updated_at",
    )
    .bind(ids::new_id())
    .bind(user_id)
    .bind(state.config.field_key.encrypt(token))
    .bind(base)
    .bind(email)
    .bind(workspace)
    .bind(now)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    for d in &devices {
        sqlx::query(
            "INSERT INTO plaud_devices (id, user_id, serial_number, name, model, version_number, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT (user_id, serial_number) DO UPDATE SET name = excluded.name, model = excluded.model, \
             version_number = excluded.version_number, updated_at = excluded.updated_at",
        )
        .bind(ids::new_id())
        .bind(user_id)
        .bind(&d.sn)
        .bind(&d.name)
        .bind(&d.model)
        .bind(d.version_number)
        .bind(now)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(devices)
}

/// The account email for a pasted token, best effort.
async fn fetch_email(base: &str, token: &str) -> Option<String> {
    Client::new(base, token).user_email().await
}

pub async fn status(State(state): State<AppState>, user: CurrentUser) -> ApiResult<Json<Value>> {
    let row: Option<ConnRow> = sqlx::query_as(CONN_SQL)
        .bind(&user.id)
        .fetch_optional(&state.db)
        .await?;
    let Some(row) = row else {
        return Ok(Json(json!({ "connected": false })));
    };
    let expires = state
        .config
        .field_key
        .decrypt(&row.bearer_token)
        .ok()
        .and_then(|t| token::claims(&t))
        .and_then(|c| token::expires_at_ms(&c))
        .map(iso);
    let server = token::server_key(&row.api_base);
    let mut out = json!({
        "connected": true,
        "server": server,
        "plaudEmail": row.plaud_email,
        "needsReconnect": row.invalidated_at.is_some(),
        "tokenExpiresAt": expires,
        "createdAt": iso(row.created_at),
        "updatedAt": iso(row.updated_at),
    });
    if server == "custom" {
        out["apiBase"] = json!(row.api_base);
    }
    Ok(Json(out))
}

pub async fn disconnect(
    State(state): State<AppState>,
    user: CurrentUser,
) -> ApiResult<Json<Value>> {
    let mut tx = state.db.begin().await?;
    sqlx::query("DELETE FROM plaud_devices WHERE user_id = ?")
        .bind(&user.id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM plaud_connections WHERE user_id = ?")
        .bind(&user.id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(json!({ "success": true })))
}

pub async fn send_code(
    State(state): State<AppState>,
    _user: CurrentUser,
    bytes: Bytes,
) -> ApiResult<Json<Value>> {
    let email = present(body::<SendCodeBody>(&bytes).email).ok_or_else(|| missing("email"))?;
    let mut base = state
        .config
        .plaud_api_base
        .clone()
        .unwrap_or_else(|| token::GLOBAL_BASE.to_owned());
    // The first request plus up to three regional redirects.
    for attempt in 0..4 {
        let client = Client::new(&base, "");
        let resp = client
            .exchange(
                reqwest::Method::POST,
                "/auth/otp-send-code",
                Some(json!({ "username": email })),
                false,
                false,
            )
            .await
            .map_err(generic)?;
        let status = resp.get("status").and_then(Value::as_i64).unwrap_or(0);
        if status == -302 {
            if attempt == 3 {
                break;
            }
            let next = resp
                .pointer("/data/domains/api")
                .and_then(Value::as_str)
                .unwrap_or_default();
            base = token::allowed_base(state.config.plaud_api_base.as_deref(), next).ok_or_else(
                || {
                    AppError::bad_request("PLAUD_API_ERROR", "Plaud sent an unexpected region.")
                        .detail("plaudStatus", -302)
                },
            )?;
            continue;
        }
        let otp = resp
            .get("token")
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty());
        return match (status, otp) {
            (0, Some(t)) => Ok(Json(
                json!({ "success": true, "otpToken": t, "apiBase": base }),
            )),
            _ => {
                let msg = resp
                    .get("msg")
                    .and_then(Value::as_str)
                    .filter(|m| !m.is_empty())
                    .unwrap_or("Plaud did not send a code.");
                Err(AppError::bad_request("PLAUD_API_ERROR", msg).detail("plaudStatus", status))
            }
        };
    }
    Err(AppError::new(
        StatusCode::BAD_GATEWAY,
        "PLAUD_REGION_REDIRECT_LOOP",
        "Plaud redirected the sign-in too many times.",
    ))
}

pub async fn verify(
    State(state): State<AppState>,
    user: CurrentUser,
    bytes: Bytes,
) -> ApiResult<Json<Value>> {
    let b = body::<VerifyBody>(&bytes);
    let code = present(b.code).ok_or_else(|| missing("code"))?;
    let otp = present(b.otp_token).ok_or_else(|| missing("otpToken"))?;
    let base = allowed(
        &state,
        &present(b.api_base).ok_or_else(|| missing("apiBase"))?,
    )?;
    let email = present(b.email).map(|e| e.to_lowercase());

    let resp = Client::new(&base, "")
        .exchange(
            reqwest::Method::POST,
            "/auth/otp-login",
            Some(json!({ "code": code, "token": otp })),
            false,
            false,
        )
        .await
        .map_err(generic)?;
    let access = resp
        .get("access_token")
        .or_else(|| resp.pointer("/data/access_token"))
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty());
    let Some(access) = access else {
        let msg = resp
            .get("msg")
            .and_then(Value::as_str)
            .filter(|m| !m.is_empty())
            .unwrap_or("Invalid verification code");
        return Err(AppError::bad_request("PLAUD_OTP_INVALID", msg));
    };
    if token::claims(access)
        .as_ref()
        .is_some_and(token::is_workspace)
    {
        return Err(AppError::new(
            StatusCode::BAD_GATEWAY,
            "PLAUD_WORKSPACE_TOKEN_PASTED",
            "Plaud returned a short-lived workspace token. Sign in with the account instead.",
        ));
    }
    let devices = connect(&state, &user.id, access, &base, email).await?;
    Ok(Json(json!({ "success": true, "devices": devices })))
}

pub async fn connect_token(
    State(state): State<AppState>,
    user: CurrentUser,
    bytes: Bytes,
) -> ApiResult<Json<Value>> {
    let b = body::<ConnectTokenBody>(&bytes);
    let t = check_token(b.access_token)?;
    let base = base_or_default(&state, b.api_base)?;
    tracing::info!(
        source = b.source.as_deref().unwrap_or("unknown"),
        "plaud connect-token"
    );
    let email = fetch_email(&base, &t).await;
    let devices = connect(&state, &user.id, &t, &base, email).await?;
    Ok(Json(json!({ "success": true, "devices": devices })))
}

fn new_handoff_code() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    token::b64url_encode(&bytes)
}

pub async fn handoff_create(
    State(state): State<AppState>,
    user: CurrentUser,
) -> ApiResult<Json<Value>> {
    let code = new_handoff_code();
    let now = now_ms();
    let expires = now + HANDOFF_TTL_MS;
    sqlx::query("INSERT INTO plaud_handoffs (code, user_id, expires_at, completed_at, error, created_at) VALUES (?, ?, ?, NULL, NULL, ?)")
        .bind(&code)
        .bind(&user.id)
        .bind(expires)
        .bind(now)
        .execute(&state.db)
        .await?;
    sqlx::query(
        "DELETE FROM plaud_handoffs WHERE user_id = ? AND code NOT IN \
         (SELECT code FROM plaud_handoffs WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)",
    )
    .bind(&user.id)
    .bind(&user.id)
    .bind(HANDOFF_KEEP)
    .execute(&state.db)
    .await?;
    Ok(Json(json!({ "code": code, "expiresAt": expires })))
}

pub async fn handoff_status(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(q): Query<CodeQuery>,
) -> ApiResult<Json<Value>> {
    let code = present(q.code).ok_or_else(|| missing("code"))?;
    let row: Option<(i64, Option<i64>, Option<String>)> = sqlx::query_as(
        "SELECT expires_at, completed_at, error FROM plaud_handoffs WHERE code = ? AND user_id = ?",
    )
    .bind(&code)
    .bind(&user.id)
    .fetch_optional(&state.db)
    .await?;
    let now = now_ms();
    Ok(Json(match row {
        Some((expires, _, _)) if expires <= now => json!({ "status": "expired" }),
        Some((_, Some(_), _)) => json!({ "status": "connected" }),
        Some((_, None, error)) => match error {
            Some(error) => json!({ "status": "pending", "error": error }),
            None => json!({ "status": "pending" }),
        },
        None => json!({ "status": "expired" }),
    }))
}

pub async fn handoff_cancel(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(q): Query<CodeQuery>,
) -> ApiResult<Json<Value>> {
    let code = present(q.code).ok_or_else(|| missing("code"))?;
    sqlx::query("DELETE FROM plaud_handoffs WHERE code = ? AND user_id = ?")
        .bind(&code)
        .bind(&user.id)
        .execute(&state.db)
        .await?;
    Ok(Json(json!({ "success": true })))
}

/// Saves the token for the code's owner. Errors are returned to the caller.
async fn complete_connect(state: &AppState, user_id: &str, b: &CompleteBody) -> ApiResult<()> {
    let t = check_token(b.access_token.clone())?;
    let base = base_or_default(state, b.api_base.clone())?;
    let email = fetch_email(&base, &t).await;
    connect(state, user_id, &t, &base, email).await?;
    Ok(())
}

pub async fn handoff_complete(
    State(state): State<AppState>,
    headers: HeaderMap,
    bytes: Bytes,
) -> ApiResult<Json<Value>> {
    if headers.get("sec-fetch-site").and_then(|v| v.to_str().ok()) != Some("same-origin") {
        return Err(AppError::new(
            StatusCode::FORBIDDEN,
            "FORBIDDEN",
            "Cross-site requests are not allowed",
        ));
    }
    let b = body::<CompleteBody>(&bytes);
    let expired = || {
        AppError::new(
            StatusCode::GONE,
            "PLAUD_HANDOFF_EXPIRED",
            "This sign-in link has expired. Start again from the OpenAudioHub app.",
        )
    };
    let code = present(b.code.clone()).ok_or_else(expired)?;
    let now = now_ms();
    let row: Option<(String, i64, Option<i64>)> = sqlx::query_as(
        "SELECT user_id, expires_at, completed_at FROM plaud_handoffs WHERE code = ?",
    )
    .bind(&code)
    .fetch_optional(&state.db)
    .await?;
    let (user_id, _, _) = match row {
        Some(r) if r.1 > now && r.2.is_none() => r,
        _ => return Err(expired()),
    };
    tracing::info!(source = "browser-extension", "plaud handoff complete");

    match complete_connect(&state, &user_id, &b).await {
        Ok(()) => {
            sqlx::query("UPDATE plaud_handoffs SET completed_at = ?, error = NULL WHERE code = ?")
                .bind(now)
                .bind(&code)
                .execute(&state.db)
                .await?;
            Ok(Json(json!({ "success": true })))
        }
        Err(e) => {
            sqlx::query("UPDATE plaud_handoffs SET error = ? WHERE code = ?")
                .bind(&e.message)
                .bind(&code)
                .execute(&state.db)
                .await?;
            Err(e)
        }
    }
}

const CONNECT_PAGE: &str = r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <meta name="openaudiohub-plaud-connect" content="1">
  <title>Connect Plaud | OpenAudioHub</title>
  <style>
    :root {
      --bg: #f5f5f7;
      --card: #ffffff;
      --text: #1d1d1f;
      --sub: #86868b;
      --border: rgba(0, 0, 0, 0.08);
      --primary: #0071e3;
      --primary-hover: #0077ed;
      --error: #df1b41;
      --success: #34c759;
    }
    @media (prefers-color-scheme: dark){
      :root {
        --bg: #000000;
        --card: #1c1c1e;
        --text: #f5f5f7;
        --sub: #a1a1a6;
        --border: rgba(255, 255, 255, 0.12);
        --primary: #2997ff;
        --primary-hover: #3ca1ff;
        --error: #ff453a;
        --success: #30d158;
      }
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      background: var(--card);
      border: solid 1px var(--border);
      border-radius: 16px;
      max-width: 440px;
      width: 100%;
      padding: 32px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.05);
      text-align: center;
    }
    h1 { font-size: 20px; font-weight: 600; margin-bottom: 20px; }
    p { font-size: 14px; color: var(--sub); line-height: 1.5; margin-bottom: 16px; }
    .steps { text-align: left; margin: 0 0 20px; padding-left: 20px; color: var(--sub); font-size: 14px; line-height: 1.6; }
    .steps li { margin-bottom: 8px; }
    .link { color: var(--primary); text-decoration: none; }
    .link:hover { text-decoration: underline; }
    .spinner {
      display: inline-block;
      width: 18px;
      height: 18px;
      border: 2px solid var(--border);
      border-top-color: var(--primary);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      vertical-align: middle;
      margin-right: 8px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .error-msg { color: var(--error); }
    .success-msg { color: var(--success); font-weight: 600; font-size: 16px; }
    .hidden { display: none; }
  </style>
</head>
<body>
  <main class="card">
    <h1>Connect Plaud to OpenAudioHub</h1>
    <div id="view-start" data-testid="connect-start">
      <ol class="steps">
        <li>Click the OpenAudioHub icon in your browser toolbar. If you do not see it, open the extensions menu.</li>
        <li>Choose Connect, then sign in to Plaud if asked.</li>
      </ol>
      <p>Do not have the extension yet? <a class="link" id="install-link" data-testid="connect-install-link" href="https://github.com/JeremyL691/OpenAudioHub/releases/latest/download/OpenAudioHub_Extension.zip">Download the browser extension</a>, then <a class="link" href="/docs/guides/browser-extension" target="_blank" rel="noopener noreferrer">follow the install steps</a>.</p>
    </div>
    <div id="view-waiting" data-testid="connect-waiting" class="hidden">
      <p><span class="spinner"></span>Waiting for Plaud sign-in. Finish signing in in the Plaud tab.</p>
    </div>
    <div id="view-success" data-testid="connect-success" class="hidden">
      <p class="success-msg">Plaud is connected. You can close this tab and return to OpenAudioHub.</p>
    </div>
    <div id="view-error" data-testid="connect-error" class="hidden">
      <p class="error-msg" id="error-text" data-testid="connect-error-text"></p>
    </div>
  </main>
  <script>
    (function () {
      var code = (new URLSearchParams(window.location.search).get("code") || "").trim();
      var viewStart = document.getElementById("view-start");
      var viewWaiting = document.getElementById("view-waiting");
      var viewSuccess = document.getElementById("view-success");
      var viewError = document.getElementById("view-error");
      var errorText = document.getElementById("error-text");
      var busy = false;
      var done = false;
      var retry = "Click the OpenAudioHub icon to try again.";
      var failureText = {
        timeout: "Plaud sign-in timed out after 5 minutes. Click the OpenAudioHub icon to try again.",
        cancelled: "Sign-in was cancelled. Click the OpenAudioHub icon to try again.",
        replaced: "Another Plaud sign-in started in this browser."
      };

      function show(element) { element.classList.remove("hidden"); }
      function hide(element) { element.classList.add("hidden"); }

      function showError(message) {
        hide(viewStart);
        hide(viewWaiting);
        hide(viewSuccess);
        var text = typeof message === "string" && message ? message : "The Plaud sign-in did not finish.";
        if (!text.endsWith(retry)) text += " " + retry;
        errorText.textContent = text;
        show(viewError);
      }

      if (!code) {
        hide(viewStart);
        errorText.textContent = "This sign-in link is missing the authorization code. Please start again from OpenAudioHub.";
        show(viewError);
        return;
      }

      function complete(accessToken, apiBase) {
        if (busy || done) return;
        busy = true;
        var body = { code: code, accessToken: accessToken };
        if (apiBase) body.apiBase = apiBase;
        fetch("/api/plaud/auth/handoff/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        }).then(function (res) {
          if (res.ok) return null;
          return res.json().catch(function () { return {}; }).then(function (data) {
            throw new Error(data.error || data.message || "The sign-in could not be completed.");
          });
        }).then(function () {
          done = true;
          hide(viewStart);
          hide(viewWaiting);
          hide(viewError);
          show(viewSuccess);
        }).catch(function (err) {
          busy = false;
          showError(err && err.message ? err.message : "The sign-in could not be completed.");
        });
      }

      window.addEventListener("message", function (event) {
        if (window !== event.source) return;
        if (event.origin !== location.origin) return;
        var data = event.data;
        if (!data || data.app !== "openaudiohub-extension" || data.protocol !== 1) return;
        if (done) return;
        if (data.kind === "waiting") {
          hide(viewStart);
          hide(viewError);
          show(viewWaiting);
          return;
        }
        if (data.kind === "token" && typeof data.accessToken === "string") {
          complete(data.accessToken, typeof data.apiBase === "string" ? data.apiBase : "");
          return;
        }
        if (data.kind === "failed") {
          showError(failureText[data.reason] || "The Plaud sign-in did not finish.");
        }
      });
    })();
  </script>
</body>
</html>
"#;

pub async fn page() -> Html<&'static str> {
    Html(CONNECT_PAGE)
}
