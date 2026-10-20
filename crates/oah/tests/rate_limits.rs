//! Per-client rate limits: a client cannot pick its own bucket (spec/auth.md).

use std::net::SocketAddr;

use axum::Router;
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Request, StatusCode, header};
use oah::{AppState, Config, db};
use tower::ServiceExt;

async fn app(trust_proxy_headers: bool) -> (Router, AppState) {
    let dir = tempfile::tempdir().unwrap();
    let mut config = Config::for_tests(dir.path());
    config.trust_proxy_headers = trust_proxy_headers;
    let state = AppState::new(config, db::open_memory().await.unwrap());
    let app = oah::app(state.clone());
    (app, state)
}

fn sign_in(peer: &str, forwarded_for: Option<&str>) -> Request<Body> {
    let addr: SocketAddr = peer.parse().unwrap();
    let mut request = Request::post("/api/auth/sign-in/email")
        .header(header::HOST, "localhost:3000")
        .header(header::ORIGIN, "http://localhost:3000")
        .header(header::CONTENT_TYPE, "application/json")
        .extension(ConnectInfo(addr))
        .body(Body::from(
            r#"{"email":"nobody@example.com","password":"wrong-password"}"#,
        ))
        .unwrap();
    if let Some(value) = forwarded_for {
        request
            .headers_mut()
            .insert("x-forwarded-for", value.parse().unwrap());
    }
    request
}

async fn status(app: &Router, peer: &str, forwarded_for: Option<&str>) -> StatusCode {
    app.clone()
        .oneshot(sign_in(peer, forwarded_for))
        .await
        .unwrap()
        .status()
}

#[tokio::test]
async fn a_forged_forwarding_header_does_not_reset_the_limit_without_trust() {
    let (app, _) = app(false).await;
    // Ten attempts are allowed in the window; the address in the header is ignored.
    for attempt in 0..10 {
        let forged = format!("203.0.113.{attempt}");
        assert_ne!(
            status(&app, "198.51.100.7:4000", Some(&forged)).await,
            StatusCode::TOO_MANY_REQUESTS,
            "attempt {attempt} must not be refused yet"
        );
    }
    assert_eq!(
        status(&app, "198.51.100.7:4000", Some("203.0.113.99")).await,
        StatusCode::TOO_MANY_REQUESTS,
        "the eleventh attempt must be refused even with a fresh header value"
    );
}

#[tokio::test]
async fn limits_are_counted_per_connection_address() {
    let (app, _) = app(false).await;
    for _ in 0..10 {
        status(&app, "198.51.100.7:4000", None).await;
    }
    assert_eq!(
        status(&app, "198.51.100.7:4000", None).await,
        StatusCode::TOO_MANY_REQUESTS
    );
    // A different connection keeps its own budget.
    assert_ne!(
        status(&app, "198.51.100.8:4001", None).await,
        StatusCode::TOO_MANY_REQUESTS
    );
}

#[tokio::test]
async fn a_trusted_proxy_address_gets_its_own_bucket_across_connections() {
    let (app, _) = app(true).await;
    // The same forwarded address is counted once, whatever connection it arrives on.
    for attempt in 0..10 {
        let peer = format!("198.51.100.{}:4000", 10 + attempt);
        assert_ne!(
            status(&app, &peer, Some("203.0.113.9")).await,
            StatusCode::TOO_MANY_REQUESTS,
            "attempt {attempt} must not be refused yet"
        );
    }
    assert_eq!(
        status(&app, "198.51.100.99:4000", Some("203.0.113.9")).await,
        StatusCode::TOO_MANY_REQUESTS,
    );
    // Another forwarded address has its own budget, even from the same connection.
    assert_ne!(
        status(&app, "198.51.100.99:4000", Some("203.0.113.201")).await,
        StatusCode::TOO_MANY_REQUESTS,
    );
}
