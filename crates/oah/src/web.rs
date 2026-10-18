//! Serves the single-page web app built into `web/dist`, plus the page-level rules the
//! server owns: sign-in redirects, the settings shortcut, and real 404s for unknown pages
//! (spec/pages.md, spec/auth.md "Pages"). Release builds embed the files; debug builds
//! read them from disk, so a `vite build` shows up without recompiling.

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode, Uri, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Redirect, Response};

use crate::AppState;
use crate::auth;
use crate::error::AppError;

#[derive(rust_embed::RustEmbed)]
#[folder = "../../web/dist"]
#[allow_missing = true]
struct Assets;

/// Headers on every response: no sniffing, no framing, a strict content policy (the app
/// loads only its own files), and HSTS when the public URL is https.
pub async fn security_headers(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    let path = request.uri().path().to_owned();
    let is_connect = path.starts_with("/connect/plaud");
    let mut response = next.run(request).await;
    // The desktop window talks to the app through Tauri's IPC endpoints.
    let ipc = if state.config.desktop.is_some() {
        " ipc: http://ipc.localhost"
    } else {
        ""
    };
    // In-browser transcription downloads its speech model from the Hugging Face hub.
    let models = " https://huggingface.co https://*.huggingface.co https://*.hf.co";
    // The connect page has an inline script and inline handlers (plaud/connect.rs), so it keeps
    // 'unsafe-inline'. It does not eval, and it only posts to this server.
    let csp = if is_connect {
        "default-src 'self' http://127.0.0.1:* http://localhost:*; \
         script-src 'self' 'unsafe-inline' chrome-extension: moz-extension: blob:; \
         worker-src 'self' blob:; \
         style-src 'self' 'unsafe-inline'; \
         img-src 'self' data: blob: https:; \
         connect-src 'self'; \
         frame-ancestors 'none'"
            .to_string()
    } else {
        format!(
            "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline' chrome-extension: moz-extension:; worker-src 'self' blob:; \
             style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; \
             connect-src 'self'{ipc}{models}; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
        )
    };
    let headers = response.headers_mut();
    let mut set = |name: &'static str, value: &str| {
        if let Ok(v) = axum::http::HeaderValue::from_str(value) {
            headers.entry(name).or_insert(v);
        }
    };
    set("x-content-type-options", "nosniff");
    set("x-frame-options", "DENY");
    set("referrer-policy", "strict-origin-when-cross-origin");
    set("content-security-policy", &csp);
    if state.config.app_url.starts_with("https://") {
        set(
            "strict-transport-security",
            "max-age=31536000; includeSubDomains",
        );
    }
    response
}

/// Settings sections reachable in a browser. `desktop` only exists in the desktop app.
const SETTINGS_SECTIONS: &[&str] = &[
    "providers",
    "transcription",
    "summary",
    "naming",
    "plaud-account",
    "sync",
    "playback",
    "display",
    "notifications",
    "storage",
    "export",
];

/// Reads a built file from `OAH_WEB_DIR` (used by parallel test runs, each with its own
/// build) or from the embedded build.
async fn asset(path: &str) -> Option<(Vec<u8>, String)> {
    if let Some(dir) = std::env::var_os("OAH_WEB_DIR") {
        // Built file names never contain "..", so anything else is refused.
        if path.split('/').any(|part| part == ".." || part.is_empty()) {
            return None;
        }
        let file = std::path::Path::new(&dir).join(path);
        let data = tokio::fs::read(&file).await.ok()?;
        let mime = match file.extension().and_then(|e| e.to_str()).unwrap_or("") {
            "html" => "text/html; charset=utf-8",
            "js" | "mjs" => "text/javascript",
            "wasm" => "application/wasm",
            "css" => "text/css",
            "svg" => "image/svg+xml",
            "png" => "image/png",
            "ico" => "image/x-icon",
            "json" | "webmanifest" => "application/json",
            "woff2" => "font/woff2",
            "txt" => "text/plain; charset=utf-8",
            "xml" => "application/xml",
            _ => "application/octet-stream",
        }
        .to_owned();
        return Some((data, mime));
    }
    Assets::get(path).map(|f| (f.data.into_owned(), f.metadata.mimetype().to_owned()))
}

enum Visitor {
    Anonymous,
    /// Holds the user id.
    Active(String),
    Suspended,
}

async fn visitor(state: &AppState, headers: &HeaderMap) -> Visitor {
    let Some(token) = auth::session_token(headers) else {
        return Visitor::Anonymous;
    };
    match auth::lookup(state, token).await {
        Ok(Some((_, true))) => Visitor::Suspended,
        Ok(Some((user, false))) => Visitor::Active(user.id),
        _ => Visitor::Anonymous,
    }
}

/// What a page path is, as far as the server cares.
#[derive(Debug, PartialEq)]
enum Page {
    Root,
    /// Sign-in and sign-up: signed-in visitors go to the dashboard.
    Auth,
    Suspended,
    /// Pages that need a session.
    App,
    /// Pages that work either way.
    Open,
    Unknown,
}

fn classify(path: &str, desktop: bool) -> Page {
    let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
    match parts.as_slice() {
        [] => Page::Root,
        ["login"] | ["register"] | ["forgot-password"] | ["reset-password"] => Page::Auth,
        ["suspended"] => Page::Suspended,
        ["connect", "plaud"] | ["install"] | ["docs", ..] => Page::Open,
        ["dashboard"] | ["recordings"] | ["recordings", _] | ["settings"] => Page::App,
        ["settings", section]
            if SETTINGS_SECTIONS.contains(section) || (desktop && *section == "desktop") =>
        {
            Page::App
        }
        _ => Page::Unknown,
    }
}

/// Any path that is not an API route.
pub async fn serve(State(state): State<AppState>, uri: Uri, headers: HeaderMap) -> Response {
    let path = uri.path().trim_start_matches('/');
    if path.starts_with("api/") || path == "api" {
        return AppError::not_found("NOT_FOUND", "Not found").into_response();
    }
    if !path.is_empty()
        && let Some((data, mime)) = asset(path).await
    {
        // Hashed build assets never change; everything else must be revalidated.
        let cache = if path.starts_with("assets/") {
            "public, max-age=31536000, immutable"
        } else {
            "no-cache"
        };
        return (
            [
                (header::CONTENT_TYPE, mime),
                (header::CACHE_CONTROL, cache.to_owned()),
            ],
            Body::from(data),
        )
            .into_response();
    }

    let who = visitor(&state, &headers).await;
    let redirect = |to: &str| Redirect::temporary(to).into_response();
    match (classify(path, state.config.desktop.is_some()), who) {
        // Signed-out visitors of a server see the landing page; the desktop app never shows it.
        (Page::Root, Visitor::Anonymous) if state.config.desktop.is_none() => app_shell().await,
        (Page::Root, _) | (Page::Auth, Visitor::Active(_)) => redirect("/dashboard"),
        (Page::Suspended, Visitor::Anonymous) | (Page::App, Visitor::Anonymous) => {
            redirect("/login")
        }
        (Page::Suspended, Visitor::Active(_)) => redirect("/recordings"),
        (Page::App, Visitor::Suspended) => redirect("/suspended"),
        (Page::App, Visitor::Active(user_id)) if path.starts_with("recordings/") => {
            let id = path.trim_end_matches('/').trim_start_matches("recordings/");
            // An unknown or someone else's recording is a real 404, not an empty page.
            let exists: Option<i64> = sqlx::query_scalar(
                "SELECT 1 FROM recordings WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
            )
            .bind(id)
            .bind(&user_id)
            .fetch_optional(&state.db)
            .await
            .unwrap_or(None);
            if exists.is_some() {
                app_shell().await
            } else {
                not_found(true)
            }
        }
        (Page::App, Visitor::Active(_)) if path.trim_end_matches('/') == "dashboard" => {
            match uri
                .query()
                .and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("settings=")))
            {
                Some(section) if SETTINGS_SECTIONS.contains(&section) => {
                    redirect(&format!("/settings/{section}"))
                }
                _ => app_shell().await,
            }
        }
        (Page::Unknown, who) => not_found(matches!(who, Visitor::Active(_))),
        _ => app_shell().await,
    }
}

async fn app_shell() -> Response {
    match asset("index.html").await {
        Some((index, _)) => (
            [
                (header::CONTENT_TYPE, "text/html; charset=utf-8"),
                (header::CACHE_CONTROL, "no-cache"),
            ],
            Body::from(index),
        )
            .into_response(),
        None => (
            StatusCode::NOT_FOUND,
            "The web app is not built. Run `pnpm build` in web/.",
        )
            .into_response(),
    }
}

/// A small self-contained page, so unknown URLs get a real 404 status.
fn not_found(signed_in: bool) -> Response {
    let (href, label) = if signed_in {
        ("/recordings", "Go to recordings")
    } else {
        ("/", "Back to home")
    };
    let html = format!(
        r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Page not found · OpenAudioHub</title><link rel="icon" href="/icon.svg">
<style>body{{margin:0;min-height:100vh;display:grid;place-items:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;background:#fff;color:#1d1d1f}}
@media (prefers-color-scheme:dark){{body{{background:#1c1c1e;color:#f2f2f7}}a{{color:#8ab4ff}}}}main{{text-align:center;padding:16px}}h1{{font-size:28px;margin:0 0 8px}}p{{color:#6e6e73;margin:0 0 20px}}a{{color:#1d4ed8}}</style></head>
<body><main><p>404</p><h1>Page not found</h1><p>The link may be out of date, or the page may have moved.</p><a href="{href}">{label}</a></main></body></html>"#
    );
    (
        StatusCode::NOT_FOUND,
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        html,
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::{Page, classify};

    #[test]
    fn page_classes() {
        assert_eq!(classify("", false), Page::Root);
        assert_eq!(classify("login", false), Page::Auth);
        assert_eq!(classify("recordings/abc", false), Page::App);
        assert_eq!(classify("settings/providers", false), Page::App);
        assert_eq!(classify("settings/api-keys", false), Page::Unknown);
        assert_eq!(classify("settings/desktop", false), Page::Unknown);
        assert_eq!(classify("settings/desktop", true), Page::App);
        assert_eq!(classify("settings/webhooks", false), Page::Unknown);
        assert_eq!(classify("settings/nope", false), Page::Unknown);
        assert_eq!(classify("connect/plaud", false), Page::Open);
        assert_eq!(classify("install", false), Page::Open);
        assert_eq!(classify("docs/guides/ai-providers", false), Page::Open);
        assert_eq!(classify("forgot-password", false), Page::Auth);
    }
}
