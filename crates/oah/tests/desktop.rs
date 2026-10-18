//! The desktop launch-secret exchange: the only way into a desktop build.

use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use oah::config::Desktop;
use oah::{AppState, Config, db};
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef-launch";

async fn app() -> (axum::Router, AppState) {
    let dir = tempfile::tempdir().unwrap();
    let mut config = Config::for_tests(dir.path());
    config.desktop = Some(Desktop {
        launch_secret: SECRET.into(),
        user_id: None,
    });
    let state = AppState::new(config, db::open_memory().await.unwrap());
    (oah::app(state.clone()), state)
}

fn exchange(secret: &str) -> Request<Body> {
    Request::post("/api/desktop/session")
        .header(header::HOST, "localhost:3000")
        .header(header::AUTHORIZATION, format!("Bearer {secret}"))
        .body(Body::empty())
        .unwrap()
}

#[tokio::test]
async fn wrong_secret_is_refused() {
    let (app, _) = app().await;
    let res = app.oneshot(exchange("not-the-secret")).await.unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn wrong_host_is_refused() {
    let (app, _) = app().await;
    let mut req = exchange(SECRET);
    req.headers_mut()
        .insert(header::HOST, "evil.example:3000".parse().unwrap());
    assert_eq!(
        app.oneshot(req).await.unwrap().status(),
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn right_secret_signs_in_one_local_account() {
    let (app, state) = app().await;
    for _ in 0..2 {
        let res = app.clone().oneshot(exchange(SECRET)).await.unwrap();
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
        let cookie = res
            .headers()
            .get(header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(cookie.starts_with("oah_session=") && cookie.contains("HttpOnly"));
    }
    let users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(&state.db)
        .await
        .unwrap();
    assert_eq!(users, 1);
    let sessions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions")
        .fetch_one(&state.db)
        .await
        .unwrap();
    assert_eq!(sessions, 2);
}

#[tokio::test]
async fn sign_up_is_closed_in_desktop_mode() {
    let (app, _) = app().await;
    let req = Request::post("/api/auth/sign-up/email")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"name":"x","email":"x@example.test","password":"long-enough-1"}"#,
        ))
        .unwrap();
    assert_eq!(
        app.oneshot(req).await.unwrap().status(),
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn launch_link_works_once() {
    let (app, _) = app().await;
    let link = || {
        Request::get(format!("/api/desktop/session?code={SECRET}"))
            .body(Body::empty())
            .unwrap()
    };
    let first = app.clone().oneshot(link()).await.unwrap();
    assert_eq!(first.status(), StatusCode::SEE_OTHER);
    assert_eq!(first.headers().get(header::LOCATION).unwrap(), "/dashboard");
    assert!(first.headers().get(header::SET_COOKIE).is_some());
    assert_eq!(
        app.clone().oneshot(link()).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    let wrong = Request::get("/api/desktop/session?code=nope")
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        app.oneshot(wrong).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
}
