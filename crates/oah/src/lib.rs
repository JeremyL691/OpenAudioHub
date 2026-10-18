pub mod ai;
pub mod auth;
pub mod backup;
pub mod cli;
pub mod config;
pub mod crypto;
pub mod db;
pub mod error;
pub mod ids;
pub mod jobs;
pub mod notify;
pub mod pipeline;
pub mod plaud;
pub mod ratelimit;
pub mod routes;
pub mod storage;
pub mod summary;
pub mod time;
pub mod transcribe;
pub mod web;
pub mod webhooks;

use std::sync::Arc;

use axum::Router;
use sqlx::SqlitePool;

pub use config::Config;

/// Shared by every request handler and background worker.
#[derive(Clone)]
pub struct AppState(Arc<Inner>);

pub struct Inner {
    pub config: Config,
    pub storage: storage::Storage,
    pub db: SqlitePool,
    pub limiter: ratelimit::RateLimiter,
    /// Wakes job workers when work is queued.
    pub wakeup: jobs::Wakeup,
    /// Desktop only: the launch code in the window's first URL works once.
    pub desktop_code_used: std::sync::atomic::AtomicBool,
}

impl std::ops::Deref for AppState {
    type Target = Inner;
    fn deref(&self) -> &Inner {
        &self.0
    }
}

impl AppState {
    pub fn new(config: Config, db: SqlitePool) -> Self {
        let storage = storage::Storage::new(&config);
        Self(Arc::new(Inner {
            config,
            storage,
            db,
            limiter: ratelimit::RateLimiter::default(),
            wakeup: jobs::Wakeup::default(),
            desktop_code_used: Default::default(),
        }))
    }
}

/// Starts every background worker. Called once by the server binary.
pub fn start_workers(state: &AppState) {
    transcribe::spawn(state);
    pipeline::spawn(state);
    summary::spawn(state);
    webhooks::spawn(state);
    plaud::spawn(state);
    backup::spawn(state);
    routes::recordings::spawn_waveform_backfill(state);
}

/// The full HTTP application.
pub fn app(state: AppState) -> Router {
    routes::router()
        .merge(transcribe::router())
        .merge(pipeline::router())
        .merge(summary::router())
        .merge(plaud::router())
        .merge(backup::router())
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth::origin_check,
        ))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            web::security_headers,
        ))
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .with_state(state)
}
