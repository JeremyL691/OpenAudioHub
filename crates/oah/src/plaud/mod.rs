//! Plaud connection, sign-in flows, sync, and auto sync (spec/plaud.md).

mod api;
mod connect;
mod import;
mod sync;

pub use sync::push_title;
pub mod token;

use axum::Router;
use axum::routing::{get, post};

use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/connect/plaud", get(connect::page))
        .route(
            "/api/plaud/connection",
            get(connect::status).delete(connect::disconnect),
        )
        .route("/api/plaud/sync", post(sync::manual))
        .route("/api/plaud/auth/send-code", post(connect::send_code))
        .route("/api/plaud/auth/verify", post(connect::verify))
        .route(
            "/api/plaud/auth/connect-token",
            post(connect::connect_token),
        )
        .route(
            "/api/plaud/auth/handoff",
            post(connect::handoff_create)
                .get(connect::handoff_status)
                .delete(connect::handoff_cancel),
        )
        .route(
            "/api/plaud/auth/handoff/complete",
            post(connect::handoff_complete),
        )
}

/// Starts this module's background workers.
pub fn spawn(state: &AppState) {
    sync::spawn_worker(state);
}
