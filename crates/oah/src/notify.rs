//! Outgoing email (SMTP) and Bark push notifications (spec/workers.md sections 10 and 11,
//! spec/auth.md password reset).
//!
//! Two send paths. The soft send (`send_soft`) returns whether the mail went out and logs failures.
//! The strict send (`send`) returns a `SendError` so the test email can show the reason.
//! `new_recordings` is the sync worker's entry point and never fails its caller.

use std::fmt;
use std::str::FromStr;
use std::time::Duration;

use lettre::message::{Mailbox, MultiPart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::transport::smtp::client::{Tls, TlsParameters};
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use serde_json::{Value, json};

use crate::AppState;
use crate::config::{Config, SmtpConfig};
use crate::routes::settings;

const SMTP_TIMEOUT: Duration = Duration::from_secs(30);
const BARK_TIMEOUT: Duration = Duration::from_secs(3);
/// Names listed in the HTML of the new-recordings email. The plain text lists all of them.
const HTML_NAME_LIMIT: usize = 10;

/// Why a strict send failed. Messages follow spec/workers.md section 10.1.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SendError {
    NotConfigured,
    AuthFailed,
    Failed(String),
}

impl fmt::Display for SendError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotConfigured => f.write_str(
                "SMTP is not set up yet. Add SMTP_HOST, SMTP_USER, and SMTP_PASSWORD to the server environment.",
            ),
            Self::AuthFailed => {
                f.write_str("SMTP authentication failed. Please check your SMTP_USER and SMTP_PASSWORD.")
            }
            Self::Failed(message) => f.write_str(message),
        }
    }
}

/// One email, before it is wrapped in the shared layout.
#[derive(Debug, Clone)]
pub struct Email {
    pub subject: String,
    /// Hidden line that mail clients show next to the subject.
    pub preview: String,
    pub heading: String,
    /// Body paragraphs as HTML. Callers escape any user text they put in.
    pub body_html: String,
    /// Plain-text version.
    pub text: String,
    /// Button label and link.
    pub button: Option<(String, String)>,
    /// Footer link label and link.
    pub footer: Option<(String, String)>,
}

/// True for `something@something.something`: one `@`, no spaces, a dot in the domain.
pub fn is_plain_address(value: &str) -> bool {
    if value.len() > 254 || value.chars().any(char::is_whitespace) {
        return false;
    }
    let mut parts = value.split('@');
    let (Some(local), Some(domain), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    !local.is_empty() && domain.contains('.') && domain.split('.').all(|label| !label.is_empty())
}

/// Host part of the app URL (no scheme, port or path). Used for the fallback sender address.
fn app_host(app_url: &str) -> &str {
    let rest = app_url.split("://").nth(1).unwrap_or(app_url);
    let host = rest.split(['/', ':']).next().unwrap_or_default();
    if host.is_empty() { "localhost" } else { host }
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// The branded layout shared by every email: preview line, heading, body, one button, one footer link.
pub fn render_html(email: &Email) -> String {
    let button = email
        .button
        .as_ref()
        .map(|(label, url)| {
            format!(
                r#"<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:24px 0;"><tr><td style="border-radius:8px;background:#2563eb;"><a href="{url}" style="display:inline-block;padding:12px 22px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">{label}</a></td></tr></table>"#,
                url = escape(url),
                label = escape(label),
            )
        })
        .unwrap_or_default();
    let footer = email
        .footer
        .as_ref()
        .map(|(label, url)| {
            format!(
                r#"<p style="margin:24px 0 0;font-size:13px;color:#6b7280;"><a href="{url}" style="color:#2563eb;">{label}</a></p>"#,
                url = escape(url),
                label = escape(label),
            )
        })
        .unwrap_or_default();
    format!(
        r#"<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{subject}</title></head>
<body style="margin:0;padding:0;background:#f4f5f7;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">{preview}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f4f5f7;padding:32px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;background:#ffffff;border-radius:12px;padding:32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
<tr><td>
<p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#2563eb;">OpenAudioHub</p>
<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;">{heading}</h1>
<div style="font-size:15px;line-height:1.6;color:#374151;">{body}</div>
{button}
{footer}
</td></tr></table>
</td></tr></table>
</body></html>"#,
        subject = escape(&email.subject),
        preview = escape(&email.preview),
        heading = escape(&email.heading),
        body = email.body_html,
    )
}

fn app_link(app_url: &str, path: &str) -> String {
    format!("{app_url}{path}")
}

/// "New recording synced" (`New recording synced` for one, `<n> new recordings synced` otherwise).
pub fn new_recordings_email(app_url: &str, titles: &[String]) -> Email {
    let count = titles.len();
    let subject = if count == 1 {
        "New recording synced".to_owned()
    } else {
        format!("{count} new recordings synced")
    };
    let recordings_url = app_link(app_url, "/recordings");
    let settings_url = app_link(app_url, "/settings/notifications");
    let sentence = if count == 1 {
        "A recording just arrived from your Plaud device.".to_owned()
    } else {
        format!("{count} recordings just arrived from your Plaud device.")
    };

    let mut items = String::new();
    for title in titles.iter().take(HTML_NAME_LIMIT) {
        items.push_str(&format!(
            r#"<li style="margin:4px 0;"><a href="{url}" style="color:#2563eb;">{name}</a></li>"#,
            url = escape(&recordings_url),
            name = escape(title),
        ));
    }
    if count > HTML_NAME_LIMIT {
        items.push_str(&format!(
            r#"<li style="margin:4px 0;color:#6b7280;">+{} more</li>"#,
            count - HTML_NAME_LIMIT
        ));
    }
    let body_html = format!(
        "<p style=\"margin:0 0 12px;\">{}</p><ul style=\"margin:0;padding-left:20px;\">{items}</ul>",
        escape(&sentence)
    );

    let mut text = format!("{sentence}\n\n");
    for title in titles {
        text.push_str(&format!("- {title}\n"));
    }
    text.push_str(&format!(
        "\nView recordings: {recordings_url}\nManage notifications: {settings_url}\n"
    ));

    Email {
        preview: sentence,
        heading: subject.clone(),
        subject,
        body_html,
        text,
        button: Some(("View recordings".into(), recordings_url)),
        footer: Some(("Manage notifications".into(), settings_url)),
    }
}

/// The test email from settings (spec/workers.md section 10.3).
pub fn test_email(app_url: &str) -> Email {
    let dashboard = app_link(app_url, "/dashboard");
    let settings_url = app_link(app_url, "/settings/notifications");
    let sentence =
        "This is a test email from OpenAudioHub. If you received it, email delivery works.";
    Email {
        subject: "Test Email from OpenAudioHub".into(),
        preview: sentence.into(),
        heading: "Test email".into(),
        body_html: format!("<p style=\"margin:0;\">{}</p>", escape(sentence)),
        text: format!(
            "The test email was received.\n\nDashboard: {dashboard}\nNotification settings: {settings_url}\n"
        ),
        button: Some(("Open dashboard".into(), dashboard)),
        footer: Some(("Manage notifications".into(), settings_url)),
    }
}

/// The "export ready" email for a finished manual export (spec/workers.md section 10.3).
pub fn export_ready_email(app_url: &str) -> Email {
    let download = app_link(app_url, "/settings/export");
    let sentence = "Your archive holds every recording's audio, transcript, and AI summary.";
    Email {
        subject: "Your OpenAudioHub export is ready".into(),
        preview: "Your OpenAudioHub data export is ready to download.".into(),
        heading: "Your export is ready".into(),
        body_html: format!("<p style=\"margin:0;\">{}</p>", escape(sentence)),
        text: format!("Your export is ready\n\n{sentence}\n\nDownload: {download}\n"),
        button: Some(("Download export".into(), download.clone())),
        footer: Some(("Download export".into(), download)),
    }
}

/// Sends the "export ready" email to the account address. Never fails the caller.
pub async fn export_ready(state: &AppState, user_id: &str) {
    if !state.config.smtp.configured() {
        return;
    }
    let email: Option<String> = sqlx::query_scalar("SELECT email FROM users WHERE id = ?")
        .bind(user_id)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten();
    if let Some(address) = email.filter(|a| is_plain_address(a)) {
        send_soft(
            &state.config,
            &address,
            &export_ready_email(&state.config.app_url),
        )
        .await;
    }
}

/// The password reset email. The link is also printed as plain text under the button.
pub fn reset_password_email(link: &str) -> Email {
    let sentence = "Use the button below to choose a new password. The link expires in 1 hour.";
    Email {
        subject: "Reset your OpenAudioHub password".into(),
        preview: "Reset your OpenAudioHub password.".into(),
        heading: "Reset your password".into(),
        body_html: format!(
            "<p style=\"margin:0 0 12px;\">{}</p><p style=\"margin:0;font-size:13px;color:#6b7280;word-break:break-all;\">{}</p>",
            escape(sentence),
            escape(link)
        ),
        text: format!(
            "Reset your password\n\n{sentence}\n\n{link}\n\nIf you did not ask for a reset, you can ignore this email.\n"
        ),
        button: Some(("Reset password".into(), link.to_owned())),
        footer: None,
    }
}

/// The From header: `SMTP_FROM`, else `SMTP_USER`, else `OpenAudioHub <noreply@host of APP_URL>`.
fn sender(config: &Config) -> String {
    let smtp = &config.smtp;
    match smtp.from.as_deref().or(smtp.user.as_deref()) {
        Some(address) => address.to_owned(),
        None => format!("OpenAudioHub <noreply@{}>", app_host(&config.app_url)),
    }
}

/// Builds the MIME message without touching the network.
pub fn build_message(config: &Config, to: &str, email: &Email) -> Result<Message, String> {
    let from =
        Mailbox::from_str(&sender(config)).map_err(|e| format!("bad sender address: {e}"))?;
    let to = Mailbox::from_str(to).map_err(|e| format!("bad recipient address: {e}"))?;
    let mut builder = Message::builder()
        .from(from)
        .to(to)
        .subject(email.subject.clone());
    if let Some(reply_to) = config.smtp.reply_to.as_deref() {
        let reply_to =
            Mailbox::from_str(reply_to).map_err(|e| format!("bad reply-to address: {e}"))?;
        builder = builder.reply_to(reply_to);
    }
    builder
        .multipart(MultiPart::alternative_plain_html(
            email.text.clone(),
            render_html(email),
        ))
        .map_err(|e| format!("could not build email: {e}"))
}

fn transport(smtp: &SmtpConfig) -> Result<AsyncSmtpTransport<Tokio1Executor>, SendError> {
    let host = smtp.host.clone().ok_or(SendError::NotConfigured)?;
    let params = TlsParameters::new_rustls(host.clone())
        .map_err(|e| SendError::Failed(format!("SMTP TLS setup failed: {e}")))?;
    // Implicit TLS for SMTP_SECURE=true, STARTTLS otherwise.
    let tls = if smtp.secure {
        Tls::Wrapper(params)
    } else {
        Tls::Required(params)
    };
    let mut builder = AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(host)
        .port(smtp.port)
        .tls(tls)
        .timeout(Some(SMTP_TIMEOUT));
    if let (Some(user), Some(password)) = (smtp.user.as_ref(), smtp.password.as_ref()) {
        builder = builder.credentials(Credentials::new(user.clone(), password.clone()));
    }
    Ok(builder.build())
}

fn map_error(smtp: &SmtpConfig, error: &lettre::transport::smtp::Error) -> SendError {
    let server = format!("{}:{}", smtp.host.as_deref().unwrap_or_default(), smtp.port);
    if error
        .status()
        .is_some_and(|code| matches!(code.to_string().as_str(), "534" | "535"))
    {
        return SendError::AuthFailed;
    }
    if error.is_timeout() {
        return SendError::Failed(
            "Timed out waiting for the SMTP server. Check that SMTP_HOST and SMTP_PORT are right."
                .into(),
        );
    }
    if error.is_response() || error.is_permanent() || error.is_transient() {
        return SendError::Failed(format!("SMTP error: {error}"));
    }
    if error.is_tls() {
        return SendError::Failed(format!("SMTP error: {error}"));
    }
    SendError::Failed(format!(
        "Could not reach the SMTP server at {server}. Make sure SMTP_HOST and SMTP_PORT are entered correctly."
    ))
}

/// Strict send: the caller sees why it failed. Used by the test email.
pub async fn send(config: &Config, to: &str, email: &Email) -> Result<(), SendError> {
    if !config.smtp.configured() {
        return Err(SendError::NotConfigured);
    }
    let message = build_message(config, to, email).map_err(SendError::Failed)?;
    let transport = transport(&config.smtp)?;
    transport
        .send(message)
        .await
        .map(|_| ())
        .map_err(|e| map_error(&config.smtp, &e))
}

/// Soft send: true when the server accepted the mail. Failures are logged, never raised.
pub async fn send_soft(config: &Config, to: &str, email: &Email) -> bool {
    match send(config, to, email).await {
        Ok(()) => true,
        Err(error) => {
            tracing::warn!(subject = %email.subject, %error, "email not sent");
            false
        }
    }
}

/// Sends the test email with the strict path (POST /api/settings/test-email).
pub async fn send_test(config: &Config, to: &str) -> Result<(), SendError> {
    send(config, to, &test_email(&config.app_url)).await
}

/// The Bark request body for new recordings (spec/workers.md section 11).
pub fn bark_payload(app_url: &str, titles: &[String]) -> Value {
    let count = titles.len();
    let (title, body) = if count == 1 {
        (
            "New recording synced".to_owned(),
            "A recording just arrived from your Plaud device".to_owned(),
        )
    } else {
        (
            format!("{count} new recordings synced"),
            format!("{count} recordings just arrived from your Plaud device"),
        )
    };
    let mut payload = json!({
        "title": title,
        "body": body,
        "url": format!("{app_url}/dashboard"),
        "group": "openaudiohub-recordings",
        "sound": "minuet",
        "badge": count,
    });
    if !titles.is_empty() {
        let shown: Vec<&str> = titles.iter().take(3).map(String::as_str).collect();
        let more = if count > 3 { "..." } else { "" };
        payload["subtitle"] = json!(format!("{}{more}", shown.join(", ")));
    }
    payload
}

/// POSTs a Bark payload with the 3 second timeout. Any non-2xx answer or a timeout is
/// "failed or timed out"; any other error is "failed". A push URL that is not an absolute
/// http or https address is refused before any request is made.
pub async fn send_bark(url: &str, payload: &Value) -> Result<(), String> {
    send_bark_within(url, payload, BARK_TIMEOUT).await
}

/// The Bark push URL must be an absolute http or https address with a host.
fn is_bark_url(url: &str) -> bool {
    reqwest::Url::parse(url)
        .map(|parsed| matches!(parsed.scheme(), "http" | "https") && parsed.host_str().is_some())
        .unwrap_or(false)
}

/// The kind of a failed Bark request, for logs. The URL is never logged: it holds the device key.
fn bark_error_kind(error: &reqwest::Error) -> &'static str {
    if error.is_timeout() {
        "timeout"
    } else if error.is_connect() {
        "connect"
    } else if error.is_status() {
        "status"
    } else if error.is_redirect() {
        "redirect"
    } else if error.is_builder() {
        "builder"
    } else if error.is_body() {
        "body"
    } else if error.is_decode() {
        "decode"
    } else {
        "request"
    }
}

async fn send_bark_within(url: &str, payload: &Value, timeout: Duration) -> Result<(), String> {
    if !is_bark_url(url) {
        tracing::warn!("Bark push URL is not an http or https address; not sent");
        return Err("Bark push URL is not an http or https address".into());
    }
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| {
            tracing::warn!(
                kind = bark_error_kind(&error),
                "Bark client could not be built"
            );
            "Bark notification failed".to_string()
        })?;
    let response = client
        .post(url)
        .header(
            reqwest::header::CONTENT_TYPE,
            "application/json; charset=utf-8",
        )
        .body(payload.to_string())
        .send()
        .await;
    match response {
        Ok(reply) if reply.status().is_success() => Ok(()),
        Ok(reply) => {
            let status = reply.status();
            let text = reply.text().await.unwrap_or_default();
            tracing::warn!(%status, response = %text, "Bark push answered with a failure");
            Err("Bark notification failed or timed out".into())
        }
        Err(error) => {
            let error = error.without_url();
            tracing::warn!(kind = bark_error_kind(&error), "Bark request failed");
            if error.is_timeout() {
                Err("Bark notification failed or timed out".into())
            } else {
                Err("Bark notification failed".into())
            }
        }
    }
}

/// The address for email notifications: the notification address when set, else the account email.
async fn notification_address(
    state: &AppState,
    user_id: &str,
    settings: &serde_json::Map<String, Value>,
) -> Option<String> {
    let typed = settings
        .get("notificationEmail")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if let Some(address) = typed {
        return Some(address.to_owned());
    }
    sqlx::query_scalar::<_, String>("SELECT email FROM users WHERE id = ?")
        .bind(user_id)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten()
}

/// Sends the new-recordings email and/or Bark push for one sync pass that created `titles`.
/// Respects the user's toggles. Never fails the caller: problems are logged.
pub async fn new_recordings(state: &AppState, user_id: &str, titles: &[String]) {
    if titles.is_empty() {
        return;
    }
    let settings = match settings::effective(state, user_id).await {
        Ok(settings) => settings,
        Err(_) => {
            tracing::warn!("notifications skipped: settings could not be read");
            return;
        }
    };
    if settings.get("emailNotifications") == Some(&Value::Bool(true)) {
        match notification_address(state, user_id, &settings).await {
            Some(address) => {
                let email = new_recordings_email(&state.config.app_url, titles);
                send_soft(&state.config, &address, &email).await;
            }
            None => tracing::warn!("email notification skipped: no address"),
        }
    }
    if settings.get("barkNotifications") == Some(&Value::Bool(true)) {
        let url = settings
            .get("barkPushUrl")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|u| !u.is_empty());
        if let Some(url) = url {
            let payload = bark_payload(&state.config.app_url, titles);
            if let Err(message) = send_bark(url, &payload).await {
                tracing::warn!(%message, "Bark notification not sent");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    fn config_with_smtp(smtp: SmtpConfig) -> Config {
        let dir = std::env::temp_dir();
        let mut config = Config::for_tests(&dir);
        config.app_url = "https://audio.example.com".into();
        config.smtp = smtp;
        config
    }

    fn smtp(host: &str) -> SmtpConfig {
        SmtpConfig {
            host: Some(host.into()),
            port: 587,
            secure: false,
            user: Some("mailer@example.com".into()),
            password: Some("secret".into()),
            from: None,
            reply_to: None,
        }
    }

    fn titles(n: usize) -> Vec<String> {
        (1..=n).map(|i| format!("Recording {i}")).collect()
    }

    #[test]
    fn address_pattern_matches_the_spec() {
        assert!(is_plain_address("someone@example.com"));
        assert!(is_plain_address("a.b+c@sub.example.co"));
        for bad in [
            "",
            "no-at.example.com",
            "a@b",
            "a b@example.com",
            "a@@example.com",
            "@example.com",
            "a@.example.com",
            "a@example.",
        ] {
            assert!(!is_plain_address(bad), "{bad}");
        }
    }

    #[test]
    fn subject_and_bark_text_follow_the_count() {
        let one = new_recordings_email("https://a.example", &titles(1));
        assert_eq!(one.subject, "New recording synced");
        let five = new_recordings_email("https://a.example", &titles(5));
        assert_eq!(five.subject, "5 new recordings synced");

        let payload = bark_payload("https://a.example", &titles(1));
        assert_eq!(payload["title"], json!("New recording synced"));
        assert_eq!(payload["subtitle"], json!("Recording 1"));
        assert_eq!(payload["url"], json!("https://a.example/dashboard"));
        assert_eq!(payload["badge"], json!(1));

        let payload = bark_payload("https://a.example", &titles(4));
        assert_eq!(payload["title"], json!("4 new recordings synced"));
        assert_eq!(
            payload["subtitle"],
            json!("Recording 1, Recording 2, Recording 3...")
        );
        assert_eq!(
            payload["body"],
            json!("4 recordings just arrived from your Plaud device")
        );
        assert_eq!(payload["group"], json!("openaudiohub-recordings"));
        assert_eq!(payload["sound"], json!("minuet"));
    }

    #[test]
    fn html_lists_ten_names_and_escapes_them() {
        let mut names = titles(12);
        names[0] = "<b>Interview & notes</b>".into();
        let email = new_recordings_email("https://a.example", &names);
        assert!(
            email
                .body_html
                .contains("&lt;b&gt;Interview &amp; notes&lt;/b&gt;")
        );
        assert!(email.body_html.contains("+2 more"));
        assert!(!email.body_html.contains("Recording 11"));
        // The plain text lists every name.
        assert!(email.text.contains("Recording 12"));
    }

    #[test]
    fn message_has_both_parts_and_headers() {
        let mut smtp = smtp("smtp.example.com");
        smtp.from = Some("OpenAudioHub <hello@example.com>".into());
        smtp.reply_to = Some("support@example.com".into());
        let config = config_with_smtp(smtp);
        let message =
            build_message(&config, "user@example.org", &test_email(&config.app_url)).unwrap();
        let raw = String::from_utf8_lossy(&message.formatted()).into_owned();
        assert!(
            raw.contains("From: OpenAudioHub <hello@example.com>"),
            "{raw}"
        );
        assert!(raw.contains("To: user@example.org"), "{raw}");
        assert!(raw.contains("Reply-To: support@example.com"), "{raw}");
        assert!(
            raw.contains("Subject: Test Email from OpenAudioHub"),
            "{raw}"
        );
        assert!(
            raw.contains("text/plain") && raw.contains("text/html"),
            "{raw}"
        );
    }

    #[test]
    fn sender_falls_back_to_user_then_app_host() {
        let config = config_with_smtp(smtp("smtp.example.com"));
        assert_eq!(sender(&config), "mailer@example.com");
        let mut bare = smtp("smtp.example.com");
        bare.user = None;
        let config = config_with_smtp(bare);
        assert_eq!(sender(&config), "OpenAudioHub <noreply@audio.example.com>");
    }

    #[tokio::test]
    async fn strict_send_reports_not_configured_without_network() {
        let config = config_with_smtp(SmtpConfig::default());
        let error = send_test(&config, "user@example.org").await.unwrap_err();
        assert_eq!(error, SendError::NotConfigured);
        assert!(!send_soft(&config, "user@example.org", &test_email(&config.app_url)).await);
    }

    async fn read_request(socket: &mut TcpStream) -> String {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 1024];
        loop {
            let n = socket.read(&mut chunk).await.unwrap_or(0);
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
            if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&buf[..end]).to_lowercase();
                let length = head
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length:"))
                    .and_then(|v| v.trim().parse::<usize>().ok())
                    .unwrap_or(0);
                if buf.len() >= end + 4 + length {
                    break;
                }
            }
        }
        String::from_utf8_lossy(&buf).into_owned()
    }

    /// A fake Bark server that answers once with `status` and returns the request it saw.
    async fn fake_bark(status: &'static str) -> (String, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/device-key", listener.local_addr().unwrap());
        let handle = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_request(&mut socket).await;
            let reply =
                format!("HTTP/1.1 {status}\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
            socket.write_all(reply.as_bytes()).await.unwrap();
            socket.shutdown().await.ok();
            request
        });
        (url, handle)
    }

    #[tokio::test]
    async fn bark_posts_json_to_the_push_url() {
        let (url, server) = fake_bark("200 OK").await;
        let payload = bark_payload("https://a.example", &titles(2));
        send_bark(&url, &payload).await.expect("2xx is success");
        let request = server.await.unwrap();
        assert!(request.starts_with("POST /device-key "), "{request}");
        assert!(
            request
                .to_lowercase()
                .contains("content-type: application/json; charset=utf-8"),
            "{request}"
        );
        let body = request.split("\r\n\r\n").nth(1).unwrap_or_default();
        let sent: Value = serde_json::from_str(body).expect("json body");
        assert_eq!(sent["title"], json!("2 new recordings synced"));
        assert_eq!(sent["badge"], json!(2));
    }

    #[tokio::test]
    async fn bark_refuses_urls_that_are_not_http_or_https() {
        for url in [
            "ftp://push.example/device-key",
            "file:///tmp/device-key",
            "not a url",
            "https://",
        ] {
            let error = send_bark(url, &bark_payload("https://a.example", &titles(1)))
                .await
                .expect_err("refused before any request");
            assert_eq!(error, "Bark push URL is not an http or https address");
        }
    }

    #[tokio::test]
    async fn bark_server_failure_is_reported() {
        let (url, server) = fake_bark("500 Internal Server Error").await;
        let error = send_bark(&url, &bark_payload("https://a.example", &titles(1)))
            .await
            .unwrap_err();
        assert_eq!(error, "Bark notification failed or timed out");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn bark_timeout_is_reported() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/slow", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            read_request(&mut socket).await;
            // Never answer; hold the connection open past the client timeout.
            tokio::time::sleep(Duration::from_secs(2)).await;
            drop(socket);
        });
        let error = send_bark_within(
            &url,
            &bark_payload("https://a.example", &titles(1)),
            Duration::from_millis(200),
        )
        .await
        .unwrap_err();
        assert_eq!(error, "Bark notification failed or timed out");
        server.abort();
    }
}
