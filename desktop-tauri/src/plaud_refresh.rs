//! Background Plaud token refresh (spec/desktop.md section 10.3).
//!
//! The account token Plaud hands out lasts 24 hours. The Plaud web session in the app's
//! webview store issues a fresh one on page load, so a hidden window loads the Plaud site,
//! the new token is captured the same way as the interactive sign-in, and it is posted to
//! the local server. Without this the connection needs a manual reconnect once the day-old
//! token is refused.
//!
//! When that web session no longer exists, a capture yields nothing. To avoid hammering,
//! a capture is not repeated for the same token within `RETRY_AFTER_MS`; a new token
//! (new expiry) is tried at once.

use std::time::Duration;

use serde_json::{Value, json};
use tauri::{AppHandle, Manager};

use crate::bridge::{self, Shared};
use crate::files;

/// The first check runs a minute after start; later checks run every 30 minutes.
const FIRST_DELAY: Duration = Duration::from_secs(60);
const CHECK_INTERVAL: Duration = Duration::from_secs(30 * 60);
/// A refresh is due when the stored token expires within this window.
const REFRESH_BEFORE_MS: i64 = 6 * 60 * 60 * 1000;
/// A refresh gives the Plaud page this long to hand out a new token.
const REFRESH_TIMEOUT: Duration = Duration::from_secs(60);
/// Each call to the local server gives up after this long, so a hung call cannot stall the loop.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
/// After a capture attempt, the same token is not captured again for this long.
const RETRY_AFTER_MS: i64 = 6 * 60 * 60 * 1000;
const REFRESH_WINDOW: &str = "plaud-refresh";
const CONNECTION_PATH: &str = "/api/plaud/connection";
const CONNECT_TOKEN_PATH: &str = "/api/plaud/auth/connect-token";

/// What the loop keeps between checks.
struct Refresher {
    client: reqwest::Client,
    /// The app session cookie, reused until the app answers 401.
    cookie: Option<String>,
    /// The last capture attempt and the token it was made for.
    last_attempt: Option<Attempt>,
}

#[derive(Clone, Copy)]
struct Attempt {
    at_ms: i64,
    token_id: i64,
}

/// A failed call to the local server. `Unauthorized` means the session cookie was refused.
#[derive(Debug)]
enum Failure {
    Unauthorized,
    Other(String),
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Failure::Unauthorized => f.write_str("the app answered 401"),
            Failure::Other(message) => f.write_str(message),
        }
    }
}

impl Refresher {
    fn new() -> Self {
        let client = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .expect("the HTTP client builds with a timeout");
        Self {
            client,
            cookie: None,
            last_attempt: None,
        }
    }

    /// The cached session cookie, or a new session when none is cached.
    async fn session(&mut self, port: u16, launch_secret: &str) -> Result<String, Failure> {
        if let Some(cookie) = &self.cookie {
            return Ok(cookie.clone());
        }
        let cookie = session_cookie(&self.client, port, launch_secret).await?;
        self.cookie = Some(cookie.clone());
        Ok(cookie)
    }

    /// Drops the cached cookie and creates a new session.
    async fn renew_session(&mut self, port: u16, launch_secret: &str) -> Result<String, Failure> {
        self.cookie = None;
        self.session(port, launch_secret).await
    }
}

/// Starts the background check loop. `port` and `launch_secret` are this launch's server.
pub fn spawn(app: AppHandle, port: u16, launch_secret: String) {
    tauri::async_runtime::spawn(async move {
        let mut refresher = Refresher::new();
        tokio::time::sleep(FIRST_DELAY).await;
        loop {
            if let Err(e) = check(&app, port, &launch_secret, &mut refresher).await {
                log(&app, &format!("plaud token check skipped: {e}"));
            }
            tokio::time::sleep(CHECK_INTERVAL).await;
        }
    });
}

/// A refresh is due when the connection is connected and either Plaud rejected the stored
/// token, or the token expires within six hours (or already has). An unknown expiry with no
/// rejection gets no refresh.
fn refresh_due(
    connected: bool,
    needs_reconnect: bool,
    expires_ms: Option<i64>,
    now_ms: i64,
) -> bool {
    if !connected {
        return false;
    }
    if needs_reconnect {
        return true;
    }
    expires_ms.is_some_and(|exp| exp - now_ms <= REFRESH_BEFORE_MS)
}

/// Whether a capture should run now. A different token (identified by its expiry) is tried
/// at once; the same token is tried again only after `RETRY_AFTER_MS`.
fn should_try(now_ms: i64, last: Option<Attempt>, token_id: i64) -> bool {
    match last {
        None => true,
        Some(attempt) => attempt.token_id != token_id || now_ms - attempt.at_ms >= RETRY_AFTER_MS,
    }
}

/// The API host for a captured token: its `region` claim decides, the page decides otherwise.
fn api_base_for(region_claim: Option<&str>, on_china_page: bool) -> &'static str {
    match region_claim {
        Some("aws:eu-central-1") => "https://api-euc1.plaud.ai",
        Some("aws:ap-southeast-1") => "https://api-apse1.plaud.ai",
        Some("aws:us-west-2") => "https://api.plaud.ai",
        _ if on_china_page => "https://api.plaud.cn",
        _ => "https://api.plaud.ai",
    }
}

/// One check: read the connection, refresh when due, and post the new token.
async fn check(
    app: &AppHandle,
    port: u16,
    launch_secret: &str,
    refresher: &mut Refresher,
) -> Result<(), String> {
    let mut cookie = refresher
        .session(port, launch_secret)
        .await
        .map_err(|e| e.to_string())?;
    let status = match get_json(&refresher.client, port, &cookie, CONNECTION_PATH).await {
        Err(Failure::Unauthorized) => {
            cookie = refresher
                .renew_session(port, launch_secret)
                .await
                .map_err(|e| e.to_string())?;
            get_json(&refresher.client, port, &cookie, CONNECTION_PATH).await
        }
        other => other,
    }
    .map_err(|e| e.to_string())?;
    let connected = status
        .get("connected")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let needs_reconnect = status
        .get("needsReconnect")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let expires_ms = status
        .get("tokenExpiresAt")
        .and_then(Value::as_str)
        .and_then(oah::time::parse_iso);
    let now_ms = oah::db::now_ms();
    if !refresh_due(connected, needs_reconnect, expires_ms, now_ms) {
        return Ok(());
    }
    let token_id = expires_ms.unwrap_or(0);
    if !should_try(now_ms, refresher.last_attempt, token_id) {
        return Ok(());
    }
    refresher.last_attempt = Some(Attempt {
        at_ms: now_ms,
        token_id,
    });

    let on_china_page = status.get("server").and_then(Value::as_str) == Some("cn");
    let custom_base = status
        .get("apiBase")
        .and_then(Value::as_str)
        .filter(|b| !b.is_empty())
        .map(str::to_owned);
    let page = if on_china_page {
        "https://web.plaud.cn/"
    } else {
        "https://web.plaud.ai/"
    };
    let current_expiry = expires_ms.unwrap_or(0);
    let Some(token) = capture(app, page, current_expiry).await? else {
        log(app, "plaud token refresh: no new token from Plaud");
        return Ok(());
    };
    let region_claim = oah::plaud::token::claims(&token)
        .and_then(|c| c.get("region").and_then(Value::as_str).map(str::to_owned));
    let api_base = custom_base
        .unwrap_or_else(|| api_base_for(region_claim.as_deref(), on_china_page).to_owned());
    let body = json!({ "accessToken": token, "apiBase": api_base, "source": "desktop-refresh" });
    let posted = match post_json(&refresher.client, port, &cookie, CONNECT_TOKEN_PATH, &body).await
    {
        Err(Failure::Unauthorized) => {
            cookie = refresher
                .renew_session(port, launch_secret)
                .await
                .map_err(|e| e.to_string())?;
            post_json(&refresher.client, port, &cookie, CONNECT_TOKEN_PATH, &body).await
        }
        other => other,
    };
    match posted {
        Ok(Some(text)) => {
            log(
                app,
                &format!("plaud token refresh: the app rejected the new token ({text})"),
            );
            Ok(())
        }
        Ok(None) => {
            log(app, "plaud token refreshed");
            Ok(())
        }
        Err(e) => {
            log(
                app,
                &format!("plaud token refresh: the app did not answer ({e})"),
            );
            Ok(())
        }
    }
}

/// Loads the Plaud page in a hidden window on the persisted web session and returns the
/// first acceptable fresh token. `None` when no usable token arrives in time.
async fn capture(
    app: &AppHandle,
    page: &str,
    current_expiry: i64,
) -> Result<Option<String>, String> {
    let url = tauri::Url::parse(page).map_err(|e| e.to_string())?;
    let captured = bridge::capture_token(
        app,
        REFRESH_WINDOW,
        "Plaud token refresh",
        url,
        false,
        REFRESH_TIMEOUT,
        current_expiry,
    )
    .await?;
    Ok(match captured {
        bridge::Captured::Token(token) => Some(token),
        bridge::Captured::Closed | bridge::Captured::TimedOut => None,
    })
}

/// `POST /api/desktop/session` once, for the app session the check calls use.
async fn session_cookie(
    client: &reqwest::Client,
    port: u16,
    launch_secret: &str,
) -> Result<String, Failure> {
    bridge::session_cookie(client, port, launch_secret)
        .await
        .map_err(Failure::Other)
}

async fn get_json(
    client: &reqwest::Client,
    port: u16,
    cookie: &str,
    path: &str,
) -> Result<Value, Failure> {
    let response = client
        .get(format!("http://127.0.0.1:{port}{path}"))
        .header("cookie", cookie)
        .send()
        .await
        .map_err(|e| Failure::Other(e.to_string()))?;
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(Failure::Unauthorized);
    }
    let text = response
        .text()
        .await
        .map_err(|e| Failure::Other(e.to_string()))?;
    if !status.is_success() {
        return Err(Failure::Other(format!(
            "the app answered {}",
            status.as_u16()
        )));
    }
    serde_json::from_str(&text).map_err(|e| Failure::Other(e.to_string()))
}

/// `Ok(None)` on success, `Ok(Some(message))` when the app refused the token.
async fn post_json(
    client: &reqwest::Client,
    port: u16,
    cookie: &str,
    path: &str,
    body: &Value,
) -> Result<Option<String>, Failure> {
    let response = client
        .post(format!("http://127.0.0.1:{port}{path}"))
        .header("cookie", cookie)
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| Failure::Other(e.to_string()))?;
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(Failure::Unauthorized);
    }
    let text = response.text().await.unwrap_or_default();
    if status.is_success() {
        return Ok(None);
    }
    let message = serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|v| v.get("message").and_then(Value::as_str).map(str::to_owned))
        .unwrap_or_else(|| format!("status {}", status.as_u16()));
    Ok(Some(message))
}

fn log(app: &AppHandle, message: &str) {
    if let Some(shared) = app.try_state::<Shared>() {
        files::log(&shared.data_dir, message);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refresh_is_due_before_expiry_and_after_rejection() {
        let now = 1_000_000_000_000;
        let six_h = 6 * 60 * 60 * 1000;
        assert!(refresh_due(true, true, None, now));
        assert!(refresh_due(true, false, Some(now + six_h - 1), now));
        assert!(refresh_due(true, false, Some(now - 1), now));
        assert!(!refresh_due(true, false, Some(now + six_h + 1), now));
        assert!(!refresh_due(true, false, None, now));
        assert!(!refresh_due(false, true, None, now));
    }

    #[test]
    fn capture_is_retried_for_a_new_token_or_after_six_hours() {
        let now = 1_000_000_000_000;
        let token = 1_000_000_500_000;
        assert!(should_try(now, None, token));

        let last = Some(Attempt {
            at_ms: now,
            token_id: token,
        });
        // The same token is not captured again straight away.
        assert!(!should_try(now + 60_000, last, token));
        assert!(!should_try(now + RETRY_AFTER_MS - 1, last, token));
        // It is retried once the six hours have passed.
        assert!(should_try(now + RETRY_AFTER_MS, last, token));
        // A different token (new expiry) is tried at once.
        assert!(should_try(now + 60_000, last, token + 1));
    }

    #[test]
    fn api_hosts_follow_the_region_claim() {
        assert_eq!(
            api_base_for(Some("aws:eu-central-1"), false),
            "https://api-euc1.plaud.ai"
        );
        assert_eq!(
            api_base_for(Some("aws:ap-southeast-1"), false),
            "https://api-apse1.plaud.ai"
        );
        assert_eq!(api_base_for(None, true), "https://api.plaud.cn");
        assert_eq!(api_base_for(Some("other"), false), "https://api.plaud.ai");
    }
}
