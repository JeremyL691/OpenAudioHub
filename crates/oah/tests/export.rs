//! The export routes, and the settings surface after the backup feature was removed.

use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode, header};
use oah::config::Desktop;
use oah::{AppState, Config, db};
use serde_json::{Value, json};
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef-launch";
const ORIGIN: &str = "http://localhost:3000";

async fn signed_in() -> (axum::Router, AppState, String) {
    let dir = Box::leak(Box::new(tempfile::tempdir().unwrap()));
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

async fn request_json(
    app: &axum::Router,
    cookie: &str,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let req = Request::builder()
        .method(method)
        .uri(path)
        .header(header::HOST, "localhost:3000")
        .header(header::COOKIE, cookie)
        .header(header::ORIGIN, ORIGIN)
        .header(header::CONTENT_TYPE, "application/json")
        .body(match body {
            Some(v) => Body::from(v.to_string()),
            None => Body::empty(),
        })
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let bytes = to_bytes(res.into_body(), 4 * 1024 * 1024).await.unwrap();
    let json = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, json)
}

fn tone_wav() -> Vec<u8> {
    let samples = 8_000usize;
    let mut pcm = Vec::with_capacity(samples * 2);
    for i in 0..samples {
        let sample: i16 = if (i / 20) % 2 == 0 { 12_000 } else { -12_000 };
        pcm.extend_from_slice(&sample.to_le_bytes());
    }
    let len = pcm.len() as u32;
    let mut out = Vec::with_capacity(44 + pcm.len());
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&16_000u32.to_le_bytes());
    out.extend_from_slice(&32_000u32.to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&len.to_le_bytes());
    out.extend_from_slice(&pcm);
    out
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

#[tokio::test]
async fn ai_provider_dual_models_and_gemini_endpoints() {
    let (app, _state, cookie) = signed_in().await;
    let fake_cred = std::env::var("OAH_TEST_PROVIDER_KEY").unwrap_or_else(|_| oah::ids::new_id());

    let (status, created) = request_json(
        &app,
        &cookie,
        "POST",
        "/api/settings/ai/providers",
        Some(json!({
            "provider": "Google Gemini",
            "apiKey": fake_cred,
            "transcriptionModel": "gemini-3.5-transcribe",
            "enhancementModel": "gemini-2.5-pro",
            "transcriptionModels": ["gemini-3.5-transcribe", "gemini-2.5-flash"],
            "enhancementModels": ["gemini-2.5-pro", "gemini-2.5-flash"],
            "isDefaultTranscription": true,
            "isDefaultEnhancement": true
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let id = created["provider"]["id"].as_str().unwrap().to_owned();
    assert_eq!(created["provider"]["defaultModel"], "gemini-3.5-transcribe");
    assert_eq!(
        created["provider"]["transcriptionModel"],
        "gemini-3.5-transcribe"
    );
    assert_eq!(created["provider"]["enhancementModel"], "gemini-2.5-pro");
    assert_eq!(
        created["provider"]["transcriptionModels"],
        json!(["gemini-3.5-transcribe", "gemini-2.5-flash"])
    );
    assert_eq!(
        created["provider"]["enhancementModels"],
        json!(["gemini-2.5-pro", "gemini-2.5-flash"])
    );

    let (status, listed) =
        request_json(&app, &cookie, "GET", "/api/settings/ai/providers", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(listed["providers"][0]["id"], id);
    assert_eq!(
        listed["providers"][0]["defaultModel"],
        "gemini-3.5-transcribe"
    );

    let (status, updated) = request_json(
        &app,
        &cookie,
        "PUT",
        &format!("/api/settings/ai/providers/{id}"),
        Some(json!({
            "transcriptionModel": "gemini-2.5-flash",
            "enhancementModel": "gemini-2.5-pro-custom",
            "transcriptionModels": ["gemini-2.5-flash", "gemini-3.5-transcribe"],
            "enhancementModels": ["gemini-2.5-pro-custom", "gemini-2.0-flash"],
            "isDefaultTranscription": true,
            "isDefaultEnhancement": true
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{updated}");

    let (status, listed) =
        request_json(&app, &cookie, "GET", "/api/settings/ai/providers", None).await;
    assert_eq!(status, StatusCode::OK);
    let p = &listed["providers"][0];
    assert_eq!(p["defaultModel"], "gemini-2.5-flash");
    assert_eq!(p["transcriptionModel"], "gemini-2.5-flash");
    assert_eq!(p["enhancementModel"], "gemini-2.5-pro-custom");
    assert_eq!(
        p["transcriptionModels"],
        json!(["gemini-2.5-flash", "gemini-3.5-transcribe"])
    );
    assert_eq!(
        p["enhancementModels"],
        json!(["gemini-2.5-pro-custom", "gemini-2.0-flash"])
    );

    let (status, audio_models) = request_json(
        &app,
        &cookie,
        "POST",
        "/api/settings/ai/providers/models",
        Some(json!({
            "provider": "Google Gemini",
            "apiKey": fake_cred,
            "kind": "audio"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let audio_ids: Vec<&str> = audio_models["models"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["id"].as_str().unwrap())
        .collect();
    assert!(audio_ids.contains(&"gemini-3.5-transcribe"));

    let (status, chat_models) = request_json(
        &app,
        &cookie,
        "POST",
        "/api/settings/ai/providers/models",
        Some(json!({
            "provider": "Google Gemini",
            "apiKey": fake_cred,
            "kind": "chat"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let chat_ids: Vec<&str> = chat_models["models"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["id"].as_str().unwrap())
        .collect();
    assert!(chat_ids.contains(&"gemini-2.5-flash"));
    assert!(chat_ids.contains(&"gemini-2.5-pro"));
    assert!(!chat_ids.contains(&"gemini-3.5-transcribe"));

    let (status, saved_chat) = request_json(
        &app,
        &cookie,
        "GET",
        &format!("/api/settings/ai/providers/{id}/chat-models"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(saved_chat["configuredModel"], "gemini-2.5-pro-custom");
    let saved_ids: Vec<&str> = saved_chat["models"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["id"].as_str().unwrap())
        .collect();
    assert!(saved_ids.contains(&"gemini-2.5-pro-custom"));
    assert!(saved_ids.contains(&"gemini-2.0-flash"));
}

#[tokio::test]
async fn custom_local_storage_folder_and_bidirectional_sync() {
    let (app, _state, cookie) = signed_in().await;
    let folder = tempfile::tempdir().unwrap();
    let folder_str = folder.path().to_string_lossy().into_owned();

    let (status, res) = request_json(
        &app,
        &cookie,
        "PUT",
        "/api/settings/user",
        Some(json!({
            "localStorageFolder": folder_str,
            "recordingTitleMode": "original"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{res}");

    let wav = tone_wav();
    let later_path = folder.path().join("2026-05-01_10-00-00.wav");
    let earlier_path = folder.path().join("2026-05-01_09-00-00.wav");
    std::fs::write(&later_path, &wav).unwrap();
    std::fs::write(&earlier_path, &wav).unwrap();

    let (status, sync_res) = request_json(
        &app,
        &cookie,
        "POST",
        "/api/settings/storage/sync",
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{sync_res}");
    assert_eq!(sync_res["synced"], 2);
    assert_eq!(sync_res["removed"], 0);

    let (status, list_res) = request_json(&app, &cookie, "GET", "/api/recordings", None).await;
    assert_eq!(status, StatusCode::OK);
    let recs = list_res["recordings"].as_array().unwrap();
    assert_eq!(recs.len(), 2);
    // GET /api/recordings returns newest first (10:00 before 09:00).
    assert_eq!(recs[0]["filename"], "2026-05-01_10-00-00");
    assert_eq!(recs[1]["filename"], "2026-05-01_09-00-00");
    assert!(recs[1]["startTime"].as_str().unwrap() < recs[0]["startTime"].as_str().unwrap());
    assert!(
        recs[0]["waveformPeaks"]
            .as_array()
            .is_some_and(|p| !p.is_empty())
    );
    assert!(
        recs[1]["waveformPeaks"]
            .as_array()
            .is_some_and(|p| !p.is_empty())
    );

    // Upload a recording while localStorageFolder is configured.
    let boundary = "----oahboundary789";
    let mut mp_body = Vec::new();
    mp_body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"uploaded-clip.wav\"\r\nContent-Type: audio/wav\r\n\r\n"
        )
        .as_bytes(),
    );
    mp_body.extend_from_slice(&wav);
    mp_body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());

    let upload_req = Request::builder()
        .method("POST")
        .uri("/api/recordings/upload")
        .header(header::HOST, "localhost:3000")
        .header(header::COOKIE, &cookie)
        .header(header::ORIGIN, ORIGIN)
        .header(
            header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(Body::from(mp_body))
        .unwrap();
    let upload_res = app.clone().oneshot(upload_req).await.unwrap();
    assert_eq!(upload_res.status(), StatusCode::OK);

    let uploaded_file = folder.path().join("uploaded-clip.wav");
    assert!(
        uploaded_file.exists(),
        "uploaded file must be saved inside localStorageFolder"
    );

    let (status, list_res) = request_json(&app, &cookie, "GET", "/api/recordings", None).await;
    assert_eq!(status, StatusCode::OK);
    let recs = list_res["recordings"].as_array().unwrap();
    assert_eq!(recs.len(), 3);
    let uploaded_rec = recs
        .iter()
        .find(|r| r["filename"] == "uploaded-clip")
        .expect("uploaded recording in list");
    assert_eq!(uploaded_rec["storageType"], "local_folder");
    assert!(
        uploaded_rec["waveformPeaks"]
            .as_array()
            .is_some_and(|p| !p.is_empty())
    );
    let uploaded_id = uploaded_rec["id"].as_str().unwrap();

    // Deleting the recording via API removes the file from localStorageFolder.
    let (status, del_res) = request_json(
        &app,
        &cookie,
        "DELETE",
        &format!("/api/recordings/{uploaded_id}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{del_res}");
    assert!(
        !uploaded_file.exists(),
        "deleting the recording must delete the file from localStorageFolder"
    );

    // Removing a file directly on disk and syncing soft-deletes the recording.
    std::fs::remove_file(&earlier_path).unwrap();
    let (status, sync_res) = request_json(
        &app,
        &cookie,
        "POST",
        "/api/settings/storage/sync",
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{sync_res}");
    assert_eq!(sync_res["synced"], 0);
    assert_eq!(sync_res["removed"], 1);

    let (status, list_res) = request_json(&app, &cookie, "GET", "/api/recordings", None).await;
    assert_eq!(status, StatusCode::OK);
    let recs = list_res["recordings"].as_array().unwrap();
    assert_eq!(recs.len(), 1);
    assert_eq!(recs[0]["filename"], "2026-05-01_10-00-00");
}

#[tokio::test]
async fn zip_merge_into_local_storage_folder_does_not_duplicate_recording() {
    use std::io::Write;

    let (app, state, cookie) = signed_in().await;
    let watch_dir = tempfile::tempdir().unwrap();
    let storage_dir = tempfile::tempdir().unwrap();
    let watch_str = watch_dir.path().to_string_lossy().into_owned();
    let storage_str = storage_dir.path().to_string_lossy().into_owned();

    let (status, res) = request_json(
        &app,
        &cookie,
        "PUT",
        "/api/settings/user",
        Some(json!({
            "localStorageFolder": storage_str,
            "zipWatchFolder": watch_str,
            "zipExportFolder": storage_dir.path().to_string_lossy(),
            "zipTitleMode": "ai",
            "zipDeleteAfterMerge": false
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{res}");

    let wav = tone_wav();
    let zip_path = watch_dir.path().join("Batch_Segments.zip");
    {
        let file = std::fs::File::create(&zip_path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        for name in [
            "Rec_2026-10-29_12-00-00_to_13-00-00_UTC-0700.wav",
            "Rec_2026-10-29_13-00-00_to_14-00-00_UTC-0700.wav",
        ] {
            zip.start_file(name, opts).unwrap();
            zip.write_all(&wav).unwrap();
        }
        zip.finish().unwrap().sync_all().unwrap();
    }

    let (status, merge_res) =
        request_json(&app, &cookie, "POST", "/api/zip/merge", Some(json!({}))).await;
    assert_eq!(status, StatusCode::OK, "{merge_res}");
    assert_eq!(merge_res["merged"], 1);
    assert_eq!(merge_res["skipped"], 0);
    assert_eq!(merge_res["errors"], json!([]));
    assert!(storage_dir.path().join("2026-10-29.m4a").exists());

    let (status, sync_res) = request_json(
        &app,
        &cookie,
        "POST",
        "/api/settings/storage/sync",
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{sync_res}");
    assert_eq!(sync_res["synced"], 0);
    assert_eq!(sync_res["removed"], 0);

    let (status, list_res) = request_json(&app, &cookie, "GET", "/api/recordings", None).await;
    assert_eq!(status, StatusCode::OK);
    let recs = list_res["recordings"].as_array().unwrap();
    assert_eq!(recs.len(), 1);
    assert_eq!(recs[0]["storageType"], "local_folder");
    assert_eq!(recs[0]["filename"], "2026-10-29");
    assert!(
        recs[0]["waveformPeaks"]
            .as_array()
            .is_some_and(|p| !p.is_empty())
    );
    let rec_id = recs[0]["id"].as_str().unwrap().to_owned();

    let user_id: String = sqlx::query_scalar("SELECT id FROM users LIMIT 1")
        .fetch_one(&state.db)
        .await
        .unwrap();
    sqlx::query("UPDATE recordings SET filename = ?, title_source = 'ai' WHERE id = ?")
        .bind(state.config.field_key.encrypt("AI Generated Meeting Title"))
        .bind(&rec_id)
        .execute(&state.db)
        .await
        .unwrap();

    oah::zip_merge::rename_ai_exports(&state, &user_id, storage_dir.path())
        .await
        .unwrap();
    assert!(!storage_dir.path().join("2026-10-29.m4a").exists());
    assert!(
        storage_dir
            .path()
            .join("AI Generated Meeting Title.m4a")
            .exists()
    );

    let (status, sync_res) = request_json(
        &app,
        &cookie,
        "POST",
        "/api/settings/storage/sync",
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{sync_res}");
    assert_eq!(sync_res["synced"], 0);
    assert_eq!(sync_res["removed"], 0);

    let (status, list_res) = request_json(&app, &cookie, "GET", "/api/recordings", None).await;
    assert_eq!(status, StatusCode::OK);
    let recs = list_res["recordings"].as_array().unwrap();
    assert_eq!(recs.len(), 1);
    assert_eq!(recs[0]["id"], rec_id);
    assert_eq!(recs[0]["filename"], "AI Generated Meeting Title");

    let audio_res = app
        .clone()
        .oneshot(
            Request::get(format!("/api/recordings/{rec_id}/audio"))
                .header(header::HOST, "localhost:3000")
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(audio_res.status(), StatusCode::OK);
    let audio_bytes = to_bytes(audio_res.into_body(), 4 * 1024 * 1024)
        .await
        .unwrap();
    assert!(!audio_bytes.is_empty());
}

#[tokio::test]
async fn disabling_plaud_disconnects_active_connection() {
    let (app, state, cookie) = signed_in().await;
    let user_id: String = sqlx::query_scalar("SELECT id FROM users LIMIT 1")
        .fetch_one(&state.db)
        .await
        .unwrap();

    sqlx::query(
        "INSERT INTO plaud_connections (id, user_id, bearer_token, api_base, plaud_email, created_at, updated_at)
         VALUES ('c1', ?, ?, 'https://api.plaud.ai', 'user@example.test', 0, 0)",
    )
    .bind(&user_id)
    .bind(state.config.field_key.encrypt("eyJhbGciOiJIUzI1NiJ9.e30.sig"))
    .execute(&state.db)
    .await
    .unwrap();

    let (status, conn) = request_json(&app, &cookie, "GET", "/api/plaud/connection", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(conn["connected"], true);

    let (status, res) = request_json(
        &app,
        &cookie,
        "PUT",
        "/api/settings/user",
        Some(json!({ "plaudEnabled": false })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{res}");

    let (status, conn) = request_json(&app, &cookie, "GET", "/api/plaud/connection", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(conn["connected"], false);
}
