use axum::Router;
use axum::routing::{get, post};

use crate::AppState;

pub(crate) mod auth;
mod browser_transcription;
mod health;
mod providers;
mod public_api;
pub mod recordings;
pub mod settings;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/health", get(health::get))
        .route("/api/auth/sign-up/email", post(auth::sign_up))
        .route("/api/auth/sign-in/email", post(auth::sign_in))
        .route("/api/auth/get-session", get(auth::get_session))
        .route("/api/auth/sign-out", post(auth::sign_out))
        .route(
            "/api/desktop/session",
            post(auth::desktop_session).get(auth::desktop_session_link),
        )
        .route(
            "/api/recordings/{id}/transcription/from-browser",
            post(browser_transcription::from_browser),
        )
        .merge(auth::router())
        .merge(settings::router())
        .merge(providers::router())
        .merge(crate::webhooks::router())
        .merge(public_api::router())
        .merge(recordings::router())
        .fallback(crate::web::serve)
}
