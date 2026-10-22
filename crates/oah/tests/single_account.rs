//! Single-account mode: page visits sign in the one local account, and sign-up stays closed.

use axum::body::{Body, to_bytes};
use axum::http::{HeaderValue, Request, StatusCode, header};
use oah::{AppState, Config, db};
use serde_json::Value;
use tower::ServiceExt;

const LOCAL_HOST: &str = "localhost:3000";

async fn app(multi_user: bool) -> (axum::Router, AppState) {
    let dir = tempfile::tempdir().unwrap();
    let mut config = Config::for_tests(dir.path());
    config.multi_user = multi_user;
    let state = AppState::new(config, db::open_memory().await.unwrap());
    (oah::app(state.clone()), state)
}

fn page(path: &str, host: &str) -> Request<Body> {
    Request::get(path)
        .header(header::HOST, host)
        .body(Body::empty())
        .unwrap()
}

fn location(res: &axum::response::Response) -> &str {
    res.headers()
        .get(header::LOCATION)
        .unwrap()
        .to_str()
        .unwrap()
}

fn session_pair(res: &axum::response::Response) -> String {
    let cookie = res
        .headers()
        .get(header::SET_COOKIE)
        .expect("a session cookie")
        .to_str()
        .unwrap();
    assert!(cookie.starts_with("oah_session="));
    cookie.split(';').next().unwrap().to_owned()
}

async fn json(res: axum::response::Response) -> Value {
    let body = to_bytes(res.into_body(), 1024 * 1024).await.unwrap();
    serde_json::from_slice(&body).unwrap()
}

#[tokio::test]
async fn anonymous_root_signs_in_and_opens_the_dashboard() {
    let (app, _) = app(false).await;
    let res = app.oneshot(page("/", LOCAL_HOST)).await.unwrap();
    assert_eq!(res.status(), StatusCode::TEMPORARY_REDIRECT);
    assert_eq!(location(&res), "/dashboard");
    session_pair(&res);
}

#[tokio::test]
async fn anonymous_login_and_register_pages_sign_in() {
    let (app, _) = app(false).await;
    for path in ["/login", "/register"] {
        let res = app.clone().oneshot(page(path, LOCAL_HOST)).await.unwrap();
        assert_eq!(res.status(), StatusCode::TEMPORARY_REDIRECT, "{path}");
        assert_eq!(location(&res), "/dashboard", "{path}");
        session_pair(&res);
    }
}

#[tokio::test]
async fn anonymous_app_page_keeps_its_path_and_query() {
    let (app, _) = app(false).await;
    let res = app
        .oneshot(page("/recordings?q=x", LOCAL_HOST))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::TEMPORARY_REDIRECT);
    assert_eq!(location(&res), "/recordings?q=x");
    session_pair(&res);
}

#[tokio::test]
async fn every_visit_gets_a_session_for_the_same_local_user() {
    let (app, _) = app(false).await;
    let mut user_ids = Vec::new();
    for _ in 0..2 {
        let res = app.clone().oneshot(page("/", LOCAL_HOST)).await.unwrap();
        let cookie = session_pair(&res);
        let req = Request::get("/api/auth/get-session")
            .header(header::HOST, LOCAL_HOST)
            .header(header::COOKIE, HeaderValue::from_str(&cookie).unwrap())
            .body(Body::empty())
            .unwrap();
        let body = json(app.clone().oneshot(req).await.unwrap()).await;
        assert_eq!(body["user"]["email"], "local@openaudiohub.localhost");
        user_ids.push(body["user"]["id"].as_str().unwrap().to_owned());
    }
    assert_eq!(user_ids[0], user_ids[1]);
}

#[tokio::test]
async fn unknown_host_is_sent_to_the_app_url_without_a_session() {
    let (app, _) = app(false).await;
    let res = app.oneshot(page("/", "evil.example:3000")).await.unwrap();
    assert_eq!(res.status(), StatusCode::TEMPORARY_REDIRECT);
    assert_eq!(location(&res), "http://localhost:3000/dashboard");
    assert!(res.headers().get(header::SET_COOKIE).is_none());
}

#[tokio::test]
async fn forwarded_host_counts_as_the_app_host() {
    let (app, _) = app(false).await;
    let req = Request::get("/")
        .header(header::HOST, "internal:8080")
        .header("x-forwarded-host", LOCAL_HOST)
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::TEMPORARY_REDIRECT);
    assert_eq!(location(&res), "/dashboard");
    session_pair(&res);
}

#[tokio::test]
async fn sign_up_is_refused_in_single_account_mode() {
    let (app, _) = app(false).await;
    let req = Request::post("/api/auth/sign-up/email")
        .header(header::HOST, LOCAL_HOST)
        .header(header::ORIGIN, "http://localhost:3000")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"email":"owner@example.test","password":"long-enough-password","name":"Owner"}"#,
        ))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    let body = json(res).await;
    assert_eq!(body["code"], "REGISTRATION_DISABLED");
}

#[tokio::test]
async fn config_reports_single_account_with_registration_closed() {
    let (app, _) = app(false).await;
    let res = app
        .oneshot(page("/api/auth/config", LOCAL_HOST))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = json(res).await;
    assert_eq!(body["singleAccount"], true);
    assert_eq!(body["registrationEnabled"], false);
}

#[tokio::test]
async fn api_routes_do_not_sign_in_automatically() {
    let (app, _) = app(false).await;
    let res = app
        .oneshot(page("/api/recordings", LOCAL_HOST))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    assert!(res.headers().get(header::SET_COOKIE).is_none());
}

#[tokio::test]
async fn multi_user_mode_does_not_sign_in_anonymous_visitors() {
    let (app, _) = app(true).await;
    let res = app.clone().oneshot(page("/", LOCAL_HOST)).await.unwrap();
    assert_ne!(res.status(), StatusCode::TEMPORARY_REDIRECT);
    assert!(res.headers().get(header::SET_COOKIE).is_none());

    let res = app
        .oneshot(page("/api/auth/config", LOCAL_HOST))
        .await
        .unwrap();
    let body = json(res).await;
    assert_eq!(body["singleAccount"], false);
}
