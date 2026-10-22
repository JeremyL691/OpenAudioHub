//! Ask AI over a recording (spec/recording-chat.md), through the HTTP surface.

use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode, header};
use oah::{AppState, Config, db};
use serde_json::{Value, json};
use tower::ServiceExt;

struct Fixture {
    state: AppState,
}

async fn fixture(timeline_source: Option<&str>) -> Fixture {
    let dir = Box::leak(Box::new(tempfile::tempdir().unwrap()));
    let config = Config::for_tests(dir.path());
    let key = config.field_key.clone();
    let state = AppState::new(config, db::open_memory().await.unwrap());
    let now = oah::db::now_ms();
    sqlx::query(
        "INSERT INTO users (id, email, created_at, updated_at) VALUES ('u', 'u@test', 0, 0)",
    )
    .execute(&state.db)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO recordings (id, user_id, device_sn, plaud_file_id, filename, duration,
         start_time, end_time, filesize, file_md5, storage_type, storage_path, plaud_version,
         created_at, updated_at)
         VALUES ('rec', 'u', 'sn', 'pf', 'A meeting', 600000, 0, 600000, 1, 'md5', 'local', '/tmp/a', 'v', 0, 0)",
    )
    .execute(&state.db)
    .await
    .unwrap();
    let timeline = serde_json::json!([
        { "start_ms": 0, "end_ms": 4000, "text": "We agreed to ship on Friday." },
        { "start_ms": 4000, "end_ms": 9000, "text": "The budget is ten thousand dollars." }
    ]);
    sqlx::query(
        "INSERT INTO transcriptions (id, recording_id, user_id, text, transcription_type, provider,
         model, timeline, timeline_source, source, created_at)
         VALUES ('tr', 'rec', 'u', ?, 'server', 'OpenAI', 'whisper-1', ?, ?, 'openaudiohub', ?)",
    )
    .bind(key.encrypt("We agreed to ship on Friday. The budget is ten thousand dollars."))
    .bind(if timeline_source.is_some() {
        Some(key.encrypt_json(&timeline).to_string())
    } else {
        None
    })
    .bind(timeline_source)
    .bind(now)
    .execute(&state.db)
    .await
    .unwrap();
    Fixture { state }
}

fn session(fixture: &Fixture) -> String {
    let token = oah::ids::token_hex(32);
    let hash = {
        use sha2::Digest;
        let mut hasher = sha2::Sha256::new();
        hasher.update(token.as_bytes());
        hex::encode(hasher.finalize())
    };
    let db = fixture.state.db.clone();
    tokio::task::block_in_place(|| {
        tokio::runtime::Handle::current().block_on(async move {
            sqlx::query(
                "INSERT INTO sessions (id, user_id, expires_at, created_at, updated_at)
                 VALUES (?, 'u', ?, 0, 0)",
            )
            .bind(hash)
            .bind(oah::db::now_ms() + 86_400_000)
            .execute(&db)
            .await
            .unwrap();
        })
    });
    token
}

async fn call(
    fixture: &Fixture,
    token: &str,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let request = Request::builder()
        .method(method)
        .uri(path)
        .header(header::HOST, "localhost:3000")
        .header(header::COOKIE, format!("oah_session={token}"))
        // The origin check applies to every write; a browser always sends it.
        .header(header::ORIGIN, "http://localhost:3000")
        .header(header::CONTENT_TYPE, "application/json")
        .body(match &body {
            Some(value) => Body::from(value.to_string()),
            None => Body::empty(),
        })
        .unwrap();
    let response = oah::app(fixture.state.clone())
        .oneshot(request)
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 4 * 1024 * 1024)
        .await
        .unwrap_or_default();
    let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, value)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_chat_without_a_provider_still_shows_its_history_and_refuses_to_send() {
    let fixture = fixture(Some("native")).await;
    let token = session(&fixture);
    let (status, body) = call(&fixture, &token, "GET", "/api/recordings/rec/chat", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["canAsk"], json!(false));
    assert_eq!(body["blockedReason"], json!("noProvider"));
    assert_eq!(body["turns"], json!([]));
    assert!(
        body["revision"].as_str().is_some(),
        "the revision is reported"
    );
    assert_eq!(body["transcript"]["hasTimeline"], json!(true));

    let (status, body) = call(
        &fixture,
        &token,
        "POST",
        "/api/recordings/rec/chat/turns",
        Some(json!({ "question": "When do we ship?", "requestId": "r1" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["code"], json!("AI_PROVIDER_NOT_CONFIGURED"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_recording_without_a_transcript_cannot_be_asked() {
    let fixture = fixture(None).await;
    sqlx::query("DELETE FROM transcriptions WHERE recording_id = 'rec'")
        .execute(&fixture.state.db)
        .await
        .unwrap();
    let token = session(&fixture);
    let (status, body) = call(&fixture, &token, "GET", "/api/recordings/rec/chat", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["canAsk"], json!(false));
    assert_eq!(body["blockedReason"], json!("noTranscript"));
    assert_eq!(body["transcript"], Value::Null);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_transcript_without_a_timeline_offers_no_time() {
    let fixture = fixture(None).await;
    let token = session(&fixture);
    let (status, body) = call(&fixture, &token, "GET", "/api/recordings/rec/chat", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["transcript"]["hasTimeline"], json!(false));
    assert_eq!(body["transcript"]["timelineSource"], Value::Null);
}

#[tokio::test(flavor = "multi_thread")]
async fn another_users_recording_is_not_found() {
    let fixture = fixture(Some("native")).await;
    sqlx::query(
        "INSERT INTO users (id, email, created_at, updated_at) VALUES ('u2', 'x@test', 0, 0)",
    )
    .execute(&fixture.state.db)
    .await
    .unwrap();
    let token = session(&fixture);
    let (status, body) = call(&fixture, &token, "GET", "/api/recordings/nope/chat", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["code"], json!("RECORDING_NOT_FOUND"));
}

#[tokio::test(flavor = "multi_thread")]
async fn clearing_a_chat_moves_the_generation_forward() {
    let fixture = fixture(Some("native")).await;
    let token = session(&fixture);
    let (_, before) = call(&fixture, &token, "GET", "/api/recordings/rec/chat", None).await;
    let (status, _) = call(&fixture, &token, "DELETE", "/api/recordings/rec/chat", None).await;
    assert_eq!(status, StatusCode::OK);
    let (_, after) = call(&fixture, &token, "GET", "/api/recordings/rec/chat", None).await;
    assert!(after["generation"].as_i64().unwrap() >= before["generation"].as_i64().unwrap());
    assert_eq!(after["turns"], json!([]));
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unknown_effort_is_refused() {
    let fixture = fixture(Some("native")).await;
    let token = session(&fixture);
    let (status, body) = call(
        &fixture,
        &token,
        "PATCH",
        "/api/recordings/rec/chat",
        Some(json!({ "effort": "turbo" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["code"], json!("INVALID_INPUT"));
    assert_eq!(body["details"]["field"], json!("effort"));
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unknown_provider_is_not_saved_silently() {
    let fixture = fixture(Some("native")).await;
    let token = session(&fixture);
    let (status, body) = call(
        &fixture,
        &token,
        "PATCH",
        "/api/recordings/rec/chat",
        Some(json!({ "providerId": "prov_missing", "effort": "max" })),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(body["code"], json!("NOT_FOUND"));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_chat_response_is_not_cached() {
    let fixture = fixture(Some("native")).await;
    let token = session(&fixture);
    let request = Request::builder()
        .uri("/api/recordings/rec/chat")
        .header(header::HOST, "localhost:3000")
        .header(header::COOKIE, format!("oah_session={token}"))
        .body(Body::empty())
        .unwrap();
    let response = oah::app(fixture.state.clone())
        .oneshot(request)
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get(header::CACHE_CONTROL).unwrap(),
        "private, no-store"
    );
}

fn timeline() -> Value {
    json!([
        { "start_ms": 0, "end_ms": 4000, "text": "We agreed to ship on Friday." },
        { "start_ms": 4000, "end_ms": 9000, "text": "The budget is ten thousand dollars." }
    ])
}

fn citation(source_id: &str, quote: &str, segment: Option<i64>) -> oah::chat::citations::Citation {
    oah::chat::citations::Citation {
        source_id: source_id.into(),
        quote: quote.into(),
        speaker: None,
        start_ms: segment.map(|s| s * 4000),
        end_ms: segment.map(|s| if s == 0 { 4000 } else { 9000 }),
        approximate: false,
        segment_start: segment,
        segment_end: segment,
        line: None,
        line_start: None,
        line_end: None,
    }
}

#[test]
fn a_citation_takes_its_time_from_its_own_row() {
    let units = oah::chat::context::units(
        "We agreed to ship on Friday. The budget is ten thousand dollars.",
        Some(&json!([
            { "start_ms": 0, "end_ms": 4000, "speaker_id": "SPEAKER_00",
              "text": "We agreed to ship on Friday." },
            { "start_ms": 4000, "end_ms": 9000, "speaker_id": "SPEAKER_01",
              "text": "The budget is ten thousand dollars." }
        ])),
        oah::chat::revision::Timing::Native,
    );
    let citations = oah::chat::citations::verify("The budget [src_2].", &units);
    assert_eq!(citations.len(), 1);
    assert_eq!(citations[0].quote, "The budget is ten thousand dollars.");
    assert_eq!(
        (citations[0].start_ms, citations[0].end_ms),
        (Some(4000), Some(9000))
    );
    assert_eq!(
        (citations[0].segment_start, citations[0].segment_end),
        (Some(1), Some(1))
    );
    assert!(!citations[0].approximate);
}

#[test]
fn a_corrected_timeline_is_marked_approximate() {
    let rows =
        json!([{ "start_ms": 1500, "end_ms": 4000, "text": "We agreed to ship on Friday." }]);
    let units = oah::chat::context::units(
        "We agreed to ship on Friday.",
        Some(&rows),
        oah::chat::revision::Timing::Normalized,
    );
    let citations = oah::chat::citations::verify("[src_1]", &units);
    assert_eq!(citations[0].start_ms, Some(1500));
    assert!(
        citations[0].approximate,
        "a corrected time is a rough place to start"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_citation_can_be_resolved_to_its_transcript_target() {
    let fixture = fixture(Some("native")).await;
    let token = session(&fixture);
    let key = &fixture.state.config.field_key;
    let now = oah::db::now_ms();

    let chat_id = "chat_test";
    sqlx::query(
        "INSERT INTO recording_chats (id, recording_id, user_id, generation, created_at, updated_at)
         VALUES (?, 'rec', 'u', 1, ?, ?)",
    )
    .bind(chat_id)
    .bind(now)
    .bind(now)
    .execute(&fixture.state.db)
    .await
    .unwrap();

    let row: (String, String, i64) = sqlx::query_as(
        "SELECT id, text, created_at FROM transcriptions WHERE recording_id = 'rec' LIMIT 1",
    )
    .fetch_one(&fixture.state.db)
    .await
    .unwrap();
    let transcript_id = row.0;
    let text = key.decrypt(&row.1).unwrap();
    let created_at = row.2;
    let timeline = serde_json::json!([
        { "start_ms": 0, "end_ms": 4000, "text": "We agreed to ship on Friday." },
        { "start_ms": 4000, "end_ms": 9000, "text": "The budget is ten thousand dollars." }
    ]);
    let transcript = oah::chat::revision::Transcript {
        id: transcript_id.clone(),
        source: "openaudiohub".into(),
        text,
        timeline: Some(timeline),
        timeline_source: Some("native".into()),
        created_at,
    };
    let revision = oah::chat::revision::Revision::of("u", "rec", &transcript);

    let citations = vec![citation("src_1", "We agreed to ship on Friday.", Some(0))];

    let turn_id = "turn_test_1";
    sqlx::query(
        "INSERT INTO recording_chat_turns
         (id, chat_id, recording_id, user_id, request_id, seq, status, generation,
          question, answer, citations, revision, transcript_id, created_at, updated_at)
         VALUES (?, ?, 'rec', 'u', 'req_1', 1, 'completed', 1, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(turn_id)
    .bind(chat_id)
    .bind(key.encrypt("What did we agree?"))
    .bind(key.encrypt("We agreed on Friday [src_1]."))
    .bind(
        key.encrypt_json(&serde_json::to_value(&citations).unwrap())
            .to_string(),
    )
    .bind(&revision.hash)
    .bind(&transcript_id)
    .bind(now)
    .bind(now)
    .execute(&fixture.state.db)
    .await
    .unwrap();

    let (status, body) = call(
        &fixture,
        &token,
        "GET",
        &format!("/api/recordings/rec/chat/turns/{turn_id}/citations/src_1"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["sourceId"], json!("src_1"));
    assert_eq!(body["transcriptId"], json!(transcript_id));
    assert_eq!(body["current"], json!(true));
    assert_eq!(body["segmentStart"], json!(0));
    assert_eq!(body["segmentEnd"], json!(0));
    assert_eq!(body["startMs"], json!(0));
    assert_eq!(body["line"], json!(null));

    // Resolving an unknown citation yields 404
    let (status_404, _) = call(
        &fixture,
        &token,
        "GET",
        &format!("/api/recordings/rec/chat/turns/{turn_id}/citations/src_999"),
        None,
    )
    .await;
    assert_eq!(status_404, StatusCode::NOT_FOUND);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_saved_answer_reads_back_with_its_rows_and_partial_flag() {
    let fixture = fixture(Some("native")).await;
    let token = session(&fixture);
    let key = &fixture.state.config.field_key;
    let now = oah::db::now_ms();
    sqlx::query(
        "INSERT INTO recording_chats (id, recording_id, user_id, generation, created_at, updated_at)
         VALUES ('chat_saved', 'rec', 'u', 1, ?, ?)",
    )
    .bind(now)
    .bind(now)
    .execute(&fixture.state.db)
    .await
    .unwrap();
    let row: (String, i64) =
        sqlx::query_as("SELECT id, created_at FROM transcriptions WHERE recording_id = 'rec'")
            .fetch_one(&fixture.state.db)
            .await
            .unwrap();
    let transcript = oah::chat::revision::Transcript {
        id: row.0.clone(),
        source: "openaudiohub".into(),
        text: "We agreed to ship on Friday. The budget is ten thousand dollars.".into(),
        timeline: Some(timeline()),
        timeline_source: Some("native".into()),
        created_at: row.1,
    };
    let revision = oah::chat::revision::Revision::of("u", "rec", &transcript);
    let stored = oah::chat::citations::Stored {
        citations: vec![citation(
            "src_2",
            "The budget is ten thousand dollars.",
            Some(1),
        )],
        partial: true,
    };
    sqlx::query(
        "INSERT INTO recording_chat_turns
         (id, chat_id, recording_id, user_id, request_id, seq, status, generation,
          question, answer, citations, revision, transcript_id, created_at, updated_at)
         VALUES ('turn_saved', 'chat_saved', 'rec', 'u', 'req_s', 1, 'completed', 1, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(key.encrypt("What is the budget?"))
    .bind(key.encrypt("Ten thousand dollars [src_2]."))
    .bind(key.encrypt_json(&stored.to_value()).to_string())
    .bind(&revision.hash)
    .bind(&row.0)
    .bind(now)
    .bind(now)
    .execute(&fixture.state.db)
    .await
    .unwrap();

    let (status, body) = call(&fixture, &token, "GET", "/api/recordings/rec/chat", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let turn = &body["turns"][0];
    assert_eq!(turn["current"], json!(true));
    assert_eq!(turn["partial"], json!(true));
    let saved = &turn["citations"][0];
    assert_eq!(saved["sourceId"], json!("src_2"));
    assert_eq!(saved["segmentStart"], json!(1));
    assert_eq!(saved["startMs"], json!(4000));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_citation_of_an_older_transcript_keeps_its_text_and_loses_its_time() {
    let fixture = fixture(Some("native")).await;
    let token = session(&fixture);
    let key = &fixture.state.config.field_key;
    let now = oah::db::now_ms();
    sqlx::query(
        "INSERT INTO recording_chats (id, recording_id, user_id, generation, created_at, updated_at)
         VALUES ('chat_old', 'rec', 'u', 1, ?, ?)",
    )
    .bind(now)
    .bind(now)
    .execute(&fixture.state.db)
    .await
    .unwrap();
    let citations = vec![citation(
        "src_1",
        "Words from a transcript that was replaced.",
        Some(0),
    )];
    sqlx::query(
        "INSERT INTO recording_chat_turns
         (id, chat_id, recording_id, user_id, request_id, seq, status, generation,
          question, answer, citations, revision, transcript_id, created_at, updated_at)
         VALUES ('turn_old', 'chat_old', 'rec', 'u', 'req_o', 1, 'completed', 1, ?, ?, ?, 'rv_gone', NULL, ?, ?)",
    )
    .bind(key.encrypt("An older question?"))
    .bind(key.encrypt("An older answer [src_1]."))
    .bind(
        key.encrypt_json(&serde_json::to_value(&citations).unwrap())
            .to_string(),
    )
    .bind(now)
    .bind(now)
    .execute(&fixture.state.db)
    .await
    .unwrap();

    let (status, body) = call(&fixture, &token, "GET", "/api/recordings/rec/chat", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let saved = &body["turns"][0]["citations"][0];
    assert_eq!(
        saved["quote"],
        json!("Words from a transcript that was replaced."),
        "the words stay readable"
    );
    assert_eq!(saved["startMs"], json!(null), "no moment is claimed");
    assert_eq!(saved["endMs"], json!(null));
    assert_eq!(saved["segmentStart"], json!(null), "no row is claimed");
    assert_eq!(body["turns"][0]["current"], json!(false));
}
