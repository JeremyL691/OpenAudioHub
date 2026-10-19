//! The export routes, and the settings surface after the backup feature was removed.

use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode, header};
use oah::config::Desktop;
use oah::{AppState, Config, db};
use serde_json::Value;
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef-launch";
const ORIGIN: &str = "http://localhost:3000";

async fn signed_in() -> (axum::Router, AppState, String) {
    let dir = tempfile::tempdir().unwrap();
    let mut config = Config::for_tests(dir.path());
    config.desktop = Some(Desktop {
        launch_secret: SECRET.into(),
        user_id: None,
    });
    let state = AppState::new(config, db::open_memory().await.unwrap());
    let app = oah::app(state.clone());
    let res = app
        .clone()
        .oneshot(
            Request::post("/api/desktop/session")
                .header(header::HOST, "localhost:3000")
                .header(header::AUTHORIZATION, format!("Bearer {SECRET}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NO_CONTENT);
    let cookie = res
        .headers()
        .get(header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap();
    let pair = cookie.split(';').next().unwrap().to_owned();
    (app, state, pair)
}

#[tokio::test]
async fn backup_routes_are_gone() {
    let (app, _state, cookie) = signed_in().await;
    for path in [
        "/api/backup",
        "/api/backup/job_1",
        "/api/backup/job_1/download",
    ] {
        let res = app
            .clone()
            .oneshot(
                Request::get(path)
                    .header(header::COOKIE, &cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND, "{path}");
    }
    let res = app
        .oneshot(
            Request::post("/api/backup")
                .header(header::COOKIE, &cookie)
                .header(header::ORIGIN, ORIGIN)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn settings_do_not_offer_backup_fields() {
    let (app, _state, cookie) = signed_in().await;
    let res = app
        .clone()
        .oneshot(
            Request::get("/api/settings/user")
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = to_bytes(res.into_body(), 1024 * 1024).await.unwrap();
    let settings: Value = serde_json::from_slice(&body).unwrap();
    for field in ["backupFrequency", "backupFolder", "lastScheduledBackupAt"] {
        assert!(
            settings.get(field).is_none(),
            "{field} is still returned by the settings endpoint"
        );
    }

    // An old client that writes the retired keys gets no error and no effect.
    let res = app
        .oneshot(
            Request::put("/api/settings/user")
                .header(header::COOKIE, &cookie)
                .header(header::ORIGIN, ORIGIN)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    r#"{"backupFrequency":"daily","backupFolder":"/definitely/not/here"}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = to_bytes(res.into_body(), 1024 * 1024).await.unwrap();
    let reply: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(reply["success"], true);
}
