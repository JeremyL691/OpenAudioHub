//! Library text search: which of the user's recordings match a query.
//!
//! The browser used to ask for every transcribed recording's detail, one request per recording,
//! and match in memory. That worked for a small library and cost one round trip per recording for
//! a large one. This route answers the same question in one request: it walks the user's
//! transcripts in one query, decrypts each text, and returns the ids that match.
//!
//! Nothing is cached between requests and no plaintext index is written: the text stays encrypted
//! at rest and is decrypted for the length of the request only.

use axum::Json;
use axum::extract::{Query, State};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::AppState;
use crate::auth::CurrentUser;
use crate::error::{ApiResult, AppError};
use axum::http::StatusCode;

/// The longest query the search accepts, in characters. The library box is seeded from the
/// address with the same limit, so a longer value is refused rather than silently cut.
const MAX_QUERY_CHARS: usize = 200;

#[derive(Debug, Deserialize)]
pub struct SearchQuery {
    q: Option<String>,
}

/// One query, the recordings that match it.
///
/// The answer is the matching ids only. The list the browser already has carries the name, the
/// status and the times, so nothing else is needed to filter and sort it.
pub async fn search(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(query): Query<SearchQuery>,
) -> ApiResult<Json<Value>> {
    let needle = query.q.unwrap_or_default().trim().to_lowercase();
    if needle.is_empty() {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "INVALID_INPUT",
            "q must not be empty",
        )
        .detail("field", "q"));
    }
    if needle.chars().count() > MAX_QUERY_CHARS {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "INVALID_INPUT",
            "q must be 200 characters or fewer",
        )
        .detail("field", "q")
        .detail("maxLength", MAX_QUERY_CHARS));
    }

    // One question per kind of match, both scoped to this user and to live recordings. The name
    // is encrypted, so it is compared after decryption, in the same pass as the transcripts.
    let mut matches: Vec<String> = Vec::new();
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT id, filename FROM recordings WHERE user_id = ? AND deleted_at IS NULL",
    )
    .bind(&user.id)
    .fetch_all(&state.db)
    .await?;
    for (id, filename) in rows {
        let name = state
            .config
            .field_key
            .decrypt(&filename)
            .unwrap_or_default();
        if name.to_lowercase().contains(&needle) {
            matches.push(id);
        }
    }

    // A recording's own transcript is the one the detail page shows: the newest one for the
    // recording. Matching any older transcript would show a recording that no longer contains
    // the text the user searched for.
    let transcripts: Vec<(String, String)> = sqlx::query_as(
        "SELECT recording_id, text FROM transcriptions t
         WHERE user_id = ?
           AND created_at = (SELECT MAX(created_at) FROM transcriptions x WHERE x.recording_id = t.recording_id AND x.user_id = t.user_id)
           AND EXISTS (SELECT 1 FROM recordings r WHERE r.id = t.recording_id AND r.user_id = t.user_id AND r.deleted_at IS NULL)",
    )
    .bind(&user.id)
    .fetch_all(&state.db)
    .await?;
    for (recording_id, text) in transcripts {
        if matches.contains(&recording_id) {
            continue;
        }
        let plain = state.config.field_key.decrypt(&text).unwrap_or_default();
        if plain.to_lowercase().contains(&needle) {
            matches.push(recording_id);
        }
    }

    Ok(Json(json!({ "recordingIds": matches })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::CurrentUser;
    use crate::config::Config;
    use crate::ids;
    use axum::extract::{Query, State};

    async fn state() -> (AppState, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(
            Config::for_tests(dir.path()),
            crate::db::open_memory().await.unwrap(),
        );
        for (id, email) in [("u", "u@x.test"), ("other", "o@x.test")] {
            sqlx::query(
                "INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, 0, 0)",
            )
            .bind(id)
            .bind(email)
            .execute(&state.db)
            .await
            .unwrap();
        }
        (state, dir)
    }

    fn user(id: &str) -> CurrentUser {
        CurrentUser {
            id: id.into(),
            email: format!("{id}@x.test"),
            name: None,
            session_id: "s".into(),
        }
    }

    async fn recording(state: &AppState, id: &str, owner: &str, name: &str) {
        sqlx::query(
            "INSERT INTO recordings (id, user_id, device_sn, plaud_file_id, filename, duration, start_time, end_time, filesize, file_md5, storage_type, storage_path, plaud_version, created_at, updated_at)
             VALUES (?, ?, 'd', ?, ?, 0, 0, 0, 0, '', 'local', ?, '1', 0, 0)",
        )
        .bind(id)
        .bind(owner)
        .bind(id)
        .bind(state.config.field_key.encrypt(name))
        .bind(id)
        .execute(&state.db)
        .await
        .unwrap();
    }

    async fn transcript(state: &AppState, recording_id: &str, owner: &str, text: &str) {
        sqlx::query(
            "INSERT INTO transcriptions (id, recording_id, user_id, text, transcription_type, provider, model, source, created_at)
             VALUES (?, ?, ?, ?, 'server', 'OpenAI', 'whisper-1', 'openaudiohub', 0)",
        )
        .bind(ids::new_id())
        .bind(recording_id)
        .bind(owner)
        .bind(state.config.field_key.encrypt(text))
        .execute(&state.db)
        .await
        .unwrap();
    }

    async fn ids_for(state: &AppState, who: &str, q: &str) -> ApiResult<Vec<String>> {
        let answer = search(
            State(state.clone()),
            user(who),
            Query(SearchQuery { q: Some(q.into()) }),
        )
        .await?;
        let value = answer.0;
        Ok(value["recordingIds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_owned())
            .collect())
    }

    #[tokio::test]
    async fn a_name_match_is_found() {
        let (state, _dir) = state().await;
        recording(&state, "r1", "u", "Quarterly Review").await;
        recording(&state, "r2", "u", "Other").await;
        assert_eq!(ids_for(&state, "u", "quarterly").await.unwrap(), ["r1"]);
    }

    #[tokio::test]
    async fn a_transcript_match_is_found() {
        let (state, _dir) = state().await;
        recording(&state, "r1", "u", "name only").await;
        transcript(&state, "r1", "u", "the ONBOARDING flow needs work").await;
        assert_eq!(ids_for(&state, "u", "onboarding").await.unwrap(), ["r1"]);
    }

    #[tokio::test]
    async fn another_users_recording_is_never_returned() {
        let (state, _dir) = state().await;
        recording(&state, "r1", "u", "mine").await;
        transcript(&state, "r1", "u", "mine speaks").await;
        recording(&state, "r2", "other", "theirs").await;
        transcript(&state, "r2", "other", "mine speaks too").await;
        assert_eq!(ids_for(&state, "u", "mine").await.unwrap(), ["r1"]);
    }

    #[tokio::test]
    async fn a_deleted_recording_is_never_returned() {
        let (state, _dir) = state().await;
        recording(&state, "r1", "u", "gone").await;
        transcript(&state, "r1", "u", "gone words").await;
        sqlx::query("UPDATE recordings SET deleted_at = 1 WHERE id = 'r1'")
            .execute(&state.db)
            .await
            .unwrap();
        assert!(ids_for(&state, "u", "gone").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn an_empty_query_is_refused() {
        let (state, _dir) = state().await;
        for q in ["", "   "] {
            let outcome = ids_for(&state, "u", q).await;
            assert!(outcome.is_err(), "an empty query is refused");
        }
    }

    #[tokio::test]
    async fn an_over_long_query_is_refused() {
        let (state, _dir) = state().await;
        let long = "a".repeat(MAX_QUERY_CHARS + 1);
        assert!(ids_for(&state, "u", &long).await.is_err());
        let at_limit = "a".repeat(MAX_QUERY_CHARS);
        assert!(
            ids_for(&state, "u", &at_limit).await.is_ok(),
            "the limit itself is allowed"
        );
    }

    #[tokio::test]
    async fn matching_is_case_insensitive_in_both_directions() {
        let (state, _dir) = state().await;
        recording(&state, "r1", "u", "MiXeD Name").await;
        assert_eq!(ids_for(&state, "u", "mixed name").await.unwrap(), ["r1"]);
        assert_eq!(ids_for(&state, "u", "MIXED NAME").await.unwrap(), ["r1"]);
    }

    #[tokio::test]
    async fn a_recording_matching_both_name_and_text_appears_once() {
        let (state, _dir) = state().await;
        recording(&state, "r1", "u", "planning").await;
        transcript(&state, "r1", "u", "planning notes").await;
        assert_eq!(ids_for(&state, "u", "planning").await.unwrap(), ["r1"]);
    }

    #[tokio::test]
    async fn no_match_is_an_empty_answer_not_an_error() {
        let (state, _dir) = state().await;
        recording(&state, "r1", "u", "something").await;
        assert!(
            ids_for(&state, "u", "nothing here")
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn non_ascii_text_matches() {
        let (state, _dir) = state().await;
        recording(&state, "r1", "u", "会議の記録").await;
        transcript(&state, "r1", "u", "今日の打ち合わせ").await;
        assert_eq!(ids_for(&state, "u", "会議").await.unwrap(), ["r1"]);
        assert_eq!(ids_for(&state, "u", "打ち合わせ").await.unwrap(), ["r1"]);
    }

    #[tokio::test]
    async fn only_the_newest_transcript_is_searched() {
        let (state, _dir) = state().await;
        recording(&state, "r1", "u", "name").await;
        // Two transcripts of different sources: the newest one is what the detail page shows, so
        // it is the text a search is about.
        sqlx::query(
            "INSERT INTO transcriptions (id, recording_id, user_id, text, transcription_type, provider, model, source, created_at)
             VALUES ('old', 'r1', 'u', ?, 'server', 'Plaud', 'plaud-native', 'plaud', 0)",
        )
        .bind(state.config.field_key.encrypt("the old words"))
        .execute(&state.db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO transcriptions (id, recording_id, user_id, text, transcription_type, provider, model, source, created_at)
             VALUES ('new', 'r1', 'u', ?, 'server', 'OpenAI', 'whisper-1', 'openaudiohub', 10)",
        )
        .bind(state.config.field_key.encrypt("the new words"))
        .execute(&state.db)
        .await
        .unwrap();
        assert!(
            ids_for(&state, "u", "old words").await.unwrap().is_empty(),
            "an older transcript is not what a search is about"
        );
        assert_eq!(ids_for(&state, "u", "new words").await.unwrap(), ["r1"]);
    }

    #[tokio::test]
    async fn a_damaged_ciphertext_does_not_fail_the_search() {
        let (state, _dir) = state().await;
        recording(&state, "r1", "u", "readable").await;
        sqlx::query(
            "INSERT INTO recordings (id, user_id, device_sn, plaud_file_id, filename, duration, start_time, end_time, filesize, file_md5, storage_type, storage_path, plaud_version, created_at, updated_at)
             VALUES ('r2', 'u', 'd', 'p2', 'v1:not-valid', 0, 0, 0, 0, '', 'local', 'y', '1', 0, 0)",
        )
        .execute(&state.db)
        .await
        .unwrap();
        // The readable recording is still found; one damaged value does not take the answer away.
        assert_eq!(ids_for(&state, "u", "readable").await.unwrap(), ["r1"]);
    }
}
