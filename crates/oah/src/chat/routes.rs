//! The recording chat endpoints (spec/recording-chat.md "Endpoints").
//!
//! Reads answer from the saved conversation; the event stream carries snapshots of what was saved,
//! so a reconnecting client never asks a provider again. Every response here is `private, no-store`
//! because it holds the user's own words.

use std::convert::Infallible;
use std::time::Duration;

use axum::body::Body;
use axum::extract::{Path as UrlPath, Query, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::AppState;
use crate::ai::{Provider, can_enhance, enhancement_provider};
use crate::auth::CurrentUser;
use crate::db::now_ms;
use crate::error::{ApiResult, AppError};

use super::capabilities::{EffortChoice, support_for};
use super::context::Unit;
use super::revision::{Revision, Transcript};
use super::run::{self, Job};
use super::store::{self, NewTurn, Preference, TurnRefusal, TurnState};
use super::stream::Limits;

/// How long one event stream waits for a change before it ends.
const STREAM_IDLE: Duration = Duration::from_secs(900);
/// The longest question, in Unicode characters.
const MAX_QUESTION_CHARS: usize = 4_000;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/recordings/{id}/chat",
            get(read).patch(save).delete(clear),
        )
        .route("/api/recordings/{id}/chat/turns", post(ask))
        .route(
            "/api/recordings/{id}/chat/turns/{turnId}/events",
            get(events),
        )
        .route(
            "/api/recordings/{id}/chat/turns/{turnId}/cancel",
            post(stop),
        )
        .route(
            "/api/recordings/{id}/chat/turns/{turnId}/retry",
            post(retry),
        )
        .route(
            "/api/recordings/{id}/chat/turns/{turnId}/citations/{sourceId}",
            get(resolve_citation),
        )
}

#[derive(Deserialize, Default)]
struct Page {
    before: Option<i64>,
    /// The transcript source the recording detail shows.
    source: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreferenceBody {
    provider_id: Option<String>,
    model: Option<String>,
    effort: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AskBody {
    question: Option<String>,
    request_id: Option<String>,
    revision: Option<String>,
    /// The transcript source the recording detail shows.
    source: Option<String>,
    provider_id: Option<String>,
    model: Option<String>,
    effort: Option<String>,
}

/// What a conversation is answered from.
struct Source {
    revision: Revision,
    transcript: Transcript,
    units: Vec<Unit>,
}

/// Reads the transcript the recording detail shows, and the units an answer may cite.
///
/// `wanted` names the source the detail has selected. Without one, or when that source has no
/// transcript, the newest transcript is used, which is what the detail shows by default.
async fn source(
    state: &AppState,
    user_id: &str,
    recording_id: &str,
    wanted: Option<&str>,
) -> ApiResult<Option<Source>> {
    let mut row: Option<TranscriptRow> = None;
    if let Some(wanted) = wanted.filter(|w| !w.is_empty()) {
        row = sqlx::query_as(
            "SELECT id, source, text, timeline, timeline_source, created_at FROM transcriptions
                 WHERE recording_id = ? AND user_id = ? AND source = ?
                 ORDER BY created_at DESC, id DESC LIMIT 1",
        )
        .bind(recording_id)
        .bind(user_id)
        .bind(wanted)
        .fetch_optional(&state.db)
        .await?;
    }
    if row.is_none() {
        row = sqlx::query_as(
            "SELECT id, source, text, timeline, timeline_source, created_at FROM transcriptions
                 WHERE recording_id = ? AND user_id = ?
                 ORDER BY created_at DESC, id DESC LIMIT 1",
        )
        .bind(recording_id)
        .bind(user_id)
        .fetch_optional(&state.db)
        .await?;
    }
    let Some(TranscriptRow {
        id,
        source,
        text,
        timeline,
        timeline_source,
        created_at,
    }) = row
    else {
        return Ok(None);
    };
    let text = state
        .config
        .field_key
        .decrypt(&text)
        .map_err(AppError::internal)?;
    if text.trim().is_empty() {
        return Ok(None);
    }
    let timeline = timeline
        .as_deref()
        .map(serde_json::from_str::<Value>)
        .transpose()
        .map_err(AppError::internal)?
        .map(|value| {
            state
                .config
                .field_key
                .decrypt_json(&value)
                .map_err(AppError::internal)
        })
        .transpose()?;
    let transcript = Transcript {
        id,
        source,
        text,
        timeline,
        timeline_source,
        created_at,
    };
    let revision = Revision::of(user_id, recording_id, &transcript);
    let units = super::context::units(
        &transcript.text,
        transcript.timeline.as_ref(),
        revision.timing,
    );
    Ok(Some(Source {
        revision,
        transcript,
        units,
    }))
}

/// The transcript columns this module reads.
#[derive(sqlx::FromRow)]
struct TranscriptRow {
    id: String,
    source: String,
    text: String,
    timeline: Option<String>,
    timeline_source: Option<String>,
    created_at: i64,
}

/// The recording, if it belongs to this user and is not deleted.
async fn recording_exists(state: &AppState, user_id: &str, recording_id: &str) -> ApiResult<bool> {
    let found: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM recordings WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
    )
    .bind(recording_id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?;
    Ok(found.is_some())
}

fn no_recording() -> AppError {
    AppError::not_found("RECORDING_NOT_FOUND", "Recording not found")
}

/// The provider a conversation sends to: the saved one, else the enhancement default.
async fn provider_for(
    state: &AppState,
    user_id: &str,
    provider_id: Option<&str>,
) -> ApiResult<Option<Provider>> {
    match provider_id {
        Some(id) => {
            let row: Option<(String,)> =
                sqlx::query_as("SELECT id FROM api_credentials WHERE id = ? AND user_id = ?")
                    .bind(id)
                    .bind(user_id)
                    .fetch_optional(&state.db)
                    .await?;
            if row.is_none() {
                return Ok(None);
            }
            let provider = crate::ai::provider_by_id(state, user_id, id).await?;
            Ok(provider.filter(|p| can_enhance(&p.name)))
        }
        None => enhancement_provider(state, user_id).await,
    }
}

/// The recent complete turns of this revision, oldest first, that a new question is read with.
///
/// Only answers of the same transcript revision are sent again, so a marker in an earlier answer
/// still names the line it named then.
async fn history(
    state: &AppState,
    chat_id: &str,
    revision: &str,
) -> ApiResult<Vec<(String, String)>> {
    let key = &state.config.field_key;
    let turns = store::recent_turns(&state.db, key, chat_id, None).await?;
    let mut out: Vec<(String, String)> = turns
        .into_iter()
        .filter(|turn| {
            turn.state == TurnState::Completed
                && turn.revision == revision
                && !turn.answer.trim().is_empty()
        })
        .take(run::HISTORY_TURNS)
        .map(|turn| (turn.question, turn.answer))
        .collect();
    out.reverse();
    Ok(out)
}

/// GET /api/recordings/{id}/chat
async fn read(
    State(state): State<AppState>,
    user: CurrentUser,
    UrlPath(id): UrlPath<String>,
    Query(page): Query<Page>,
) -> ApiResult<Response> {
    if !recording_exists(&state, &user.id, &id).await? {
        return Err(no_recording());
    }
    let key = &state.config.field_key;
    let conversation = store::conversation(&state.db, &user.id, &id).await?;
    let source = source(&state, &user.id, &id, page.source.as_deref()).await?;
    let turns = match &conversation {
        Some(chat) => store::recent_turns(&state.db, key, &chat.id, page.before).await?,
        None => Vec::new(),
    };
    let active = match &conversation {
        Some(chat) => store::active_turn(&state.db, key, &chat.id).await?,
        None => None,
    };
    let preference = conversation
        .as_ref()
        .map(|chat| chat.preference.clone())
        .unwrap_or_default();
    // A stored provider that was deleted is reported, not silently replaced.
    let stored = provider_for(&state, &user.id, preference.provider_id.as_deref()).await?;
    let provider_missing = preference.provider_id.is_some() && stored.is_none();
    let provider = if provider_missing { None } else { stored };
    let (can_ask, blocked) = if source.is_none() {
        (false, Some("noTranscript"))
    } else if provider.is_none() {
        (
            false,
            Some(if provider_missing {
                "providerMissing"
            } else {
                "noProvider"
            }),
        )
    } else if active.is_some() {
        (false, Some("busy"))
    } else {
        (true, None)
    };
    let model = preference
        .model
        .clone()
        .or_else(|| provider.as_ref().map(Provider::chat_model));
    let levels = match (&provider, &model) {
        (Some(provider), Some(model)) => support_for(&provider.name, model),
        _ => super::capabilities::EffortSupport::Unknown,
    };
    let effort_levels: Vec<&str> = match &levels {
        super::capabilities::EffortSupport::Levels(levels) => {
            levels.iter().map(|level| level.as_str()).collect()
        }
        super::capabilities::EffortSupport::Unknown => Vec::new(),
    };
    let body = json!({
        "recordingId": id,
        "generation": conversation.as_ref().map(|chat| chat.generation).unwrap_or(0),
        "revision": source.as_ref().map(|s| s.revision.hash.clone()),
        "preference": {
            "providerId": preference.provider_id,
            "provider": provider.as_ref().map(|p| p.name.clone()).or(preference.provider),
            "model": model,
            "effort": preference.effort.map(EffortChoice::as_str),
        },
        "capabilities": {
            "effort": effort_levels,
            "known": !matches!(levels, super::capabilities::EffortSupport::Unknown),
        },
        "canAsk": can_ask,
        "blockedReason": blocked,
        "transcript": source.as_ref().map(|s| store::transcript_json(&s.revision, s.transcript.created_at)),
        "activeTurn": active.as_ref().map(|turn| store::turn_json_for(turn, source.as_ref().map(|s| &s.revision))),
        "turns": turns
            .iter()
            .map(|turn| store::turn_json_for(turn, source.as_ref().map(|s| &s.revision)))
            .collect::<Vec<_>>(),
    });
    Ok(no_store(Json(body).into_response()))
}

/// PATCH /api/recordings/{id}/chat
async fn save(
    State(state): State<AppState>,
    user: CurrentUser,
    UrlPath(id): UrlPath<String>,
    Json(body): Json<PreferenceBody>,
) -> ApiResult<Response> {
    if !recording_exists(&state, &user.id, &id).await? {
        return Err(no_recording());
    }
    let effort = match body.effort.as_deref() {
        None => None,
        Some("") => None,
        Some(text) => Some(
            EffortChoice::parse(text)
                .ok_or_else(|| invalid("effort must be a level").detail("field", "effort"))?,
        ),
    };
    let provider = match body.provider_id.as_deref().filter(|id| !id.is_empty()) {
        Some(provider_id) => {
            let found = provider_for(&state, &user.id, Some(provider_id)).await?;
            let found = found.ok_or_else(|| {
                AppError::new(
                    StatusCode::NOT_FOUND,
                    "NOT_FOUND",
                    "No provider with this id can answer questions",
                )
            })?;
            Some(found)
        }
        None => None,
    };
    store::conversation_or_create(&state.db, &user.id, &id).await?;
    store::save_preference(
        &state.db,
        &user.id,
        &id,
        &Preference {
            provider_id: body.provider_id.clone().filter(|id| !id.is_empty()),
            provider: provider.as_ref().map(|p| p.name.clone()),
            model: body.model.clone().filter(|m| !m.is_empty()),
            effort,
        },
    )
    .await?;
    Ok(no_store(
        Json(json!({
            "success": true,
            "preference": {
                "providerId": body.provider_id,
                "provider": provider.as_ref().map(|p| p.name.clone()),
                "model": body.model,
                "effort": effort.map(EffortChoice::as_str),
            }
        }))
        .into_response(),
    ))
}

/// DELETE /api/recordings/{id}/chat
async fn clear(
    State(state): State<AppState>,
    user: CurrentUser,
    UrlPath(id): UrlPath<String>,
) -> ApiResult<Response> {
    if !recording_exists(&state, &user.id, &id).await? {
        return Err(no_recording());
    }
    // A run in this process is told to stop before the turns go, so it saves nothing more.
    if let Some(chat) = store::conversation(&state.db, &user.id, &id).await? {
        let key = &state.config.field_key;
        if let Some(active) = store::active_turn(&state.db, key, &chat.id).await? {
            run::cancel(&active.id);
        }
    }
    store::clear(&state.db, &user.id, &id).await?;
    Ok(no_store(Json(json!({ "success": true })).into_response()))
}

/// POST /api/recordings/{id}/chat/turns
async fn ask(
    State(state): State<AppState>,
    user: CurrentUser,
    UrlPath(id): UrlPath<String>,
    Json(body): Json<AskBody>,
) -> ApiResult<Response> {
    if !recording_exists(&state, &user.id, &id).await? {
        return Err(no_recording());
    }
    let question = body.question.unwrap_or_default();
    let question = question.trim();
    if question.is_empty() {
        return Err(invalid("question must not be blank").detail("field", "question"));
    }
    if question.chars().count() > MAX_QUESTION_CHARS {
        return Err(invalid("question is too long").detail("field", "question"));
    }
    let request_id = body
        .request_id
        .filter(|id| !id.trim().is_empty())
        .ok_or_else(|| invalid("requestId is required").detail("field", "requestId"))?;
    let source = source(&state, &user.id, &id, body.source.as_deref())
        .await?
        .ok_or_else(|| invalid("transcribe the recording first").detail("field", "transcript"))?;
    if let Some(revision) = body.revision.as_deref()
        && revision != source.revision.hash
    {
        return Err(AppError::new(
            StatusCode::CONFLICT,
            "REVISION_CHANGED",
            "The transcript changed. Ask again.",
        ));
    }
    let chat = store::conversation_or_create(&state.db, &user.id, &id).await?;
    let key = &state.config.field_key;
    // A repeated request is answered with the turn it already created, and nothing runs again.
    if let Some(turn) = store::turn_by_request(&state.db, key, &chat.id, &request_id).await? {
        return Ok(no_store(
            (
                StatusCode::OK,
                Json(json!({ "turn": store::turn_json(&turn) })),
            )
                .into_response(),
        ));
    }
    let effort_choice = match body.effort.as_deref() {
        None | Some("") => chat.preference.effort.unwrap_or(EffortChoice::Default),
        Some(text) => EffortChoice::parse(text)
            .ok_or_else(|| invalid("effort must be a level").detail("field", "effort"))?,
    };
    let provider_id = body
        .provider_id
        .clone()
        .filter(|id| !id.is_empty())
        .or(chat.preference.provider_id.clone());
    let mut provider = provider_for(&state, &user.id, provider_id.as_deref())
        .await?
        .ok_or_else(|| {
            AppError::bad_request(
                "AI_PROVIDER_NOT_CONFIGURED",
                "No AI provider can answer questions.",
            )
        })?;
    let model = body
        .model
        .clone()
        .filter(|m| !m.is_empty())
        .or(chat.preference.model.clone())
        .unwrap_or_else(|| provider.chat_model());
    // The choice is remembered with the conversation, so the next send uses it too.
    store::save_preference(
        &state.db,
        &user.id,
        &id,
        &Preference {
            provider_id: Some(provider.id.clone()),
            provider: Some(provider.name.clone()),
            model: Some(model.clone()),
            effort: Some(effort_choice),
        },
    )
    .await?;
    let created = store::create_turn(
        &state.db,
        key,
        &NewTurn {
            chat_id: &chat.id,
            recording_id: &id,
            user_id: &user.id,
            request_id: &request_id,
            generation: chat.generation,
            question,
            revision: &source.revision.hash,
            transcript_id: Some(&source.revision.transcript_id),
        },
    )
    .await?;
    let turn = match created {
        Ok(turn) => turn,
        Err(TurnRefusal::Busy) => {
            return Err(AppError::new(
                StatusCode::CONFLICT,
                "CONFLICT",
                "An answer is already running.",
            ));
        }
        Err(TurnRefusal::Stale) => {
            return Err(AppError::new(
                StatusCode::CONFLICT,
                "REVISION_CHANGED",
                "The chat changed. Ask again.",
            ));
        }
        Err(TurnRefusal::Missing) => return Err(no_recording()),
    };
    let (effort, _known) = run::resolve_effort(effort_choice, &provider.name, &model);
    // The model chosen for this conversation is the one asked, not the provider's saved default.
    provider.model = Some(model);
    let history = history(&state, &chat.id, &source.revision.hash).await?;
    run::spawn(
        state.clone(),
        Job {
            recording_id: id.clone(),
            user_id: user.id.clone(),
            turn_id: turn.id.clone(),
            generation: chat.generation,
            attempt: turn.attempt,
            revision: source.revision,
            question: question.to_owned(),
            history,
            provider,
            effort_choice,
            effort,
            units: source.units,
            whole: run::asks_about_whole(question),
        },
    );
    Ok(no_store(
        (
            StatusCode::ACCEPTED,
            Json(json!({ "turn": store::turn_json(&turn) })),
        )
            .into_response(),
    ))
}

/// GET /api/recordings/{id}/chat/turns/{turnId}/events
async fn events(
    State(state): State<AppState>,
    user: CurrentUser,
    UrlPath((id, turn_id)): UrlPath<(String, String)>,
) -> ApiResult<Response> {
    if !recording_exists(&state, &user.id, &id).await? {
        return Err(no_recording());
    }
    // The key is cloned: the stream outlives this handler and must not borrow from it.
    let key = state.config.field_key.clone();
    // Reading once proves the turn exists and is this user's before any stream is opened.
    let turn = store::turn(&state.db, &key, &user.id, &id, &turn_id)
        .await?
        .ok_or_else(|| AppError::not_found("NOT_FOUND", "No such answer"))?;
    let (sender, receiver) = tokio::sync::mpsc::channel::<Result<String, Infallible>>(128);
    let worker = state.clone();
    let user_id = user.id.clone();
    let turn_id_str = turn_id.clone();
    let active_hub = super::hub::get(&turn_id);
    tokio::spawn(async move {
        let version = now_ms();
        if let Some(hub) = active_hub {
            let mut rx = hub.subscribe();
            // A run that ended before the subscription sent its `done` to nobody: answer from
            // the saved turn, which is written before `done` is sent.
            if hub.is_finished() {
                let v = now_ms();
                if let Ok(Some(cur)) =
                    store::turn(&worker.db, &key, &user_id, &id, &turn_id_str).await
                {
                    let _ = send(&sender, "snapshot", &snapshot(&cur, v)).await;
                    if !cur.citations.is_empty() {
                        let _ = send(
                            &sender,
                            "citations",
                            &json!({ "citations": cur.citations, "version": v }),
                        )
                        .await;
                    }
                }
                let _ = send(&sender, "done", &json!({ "version": v })).await;
                return;
            }
            let mut current_turn = turn;
            let live_ans = hub.current_answer();
            if !live_ans.is_empty() {
                current_turn.answer = live_ans;
            }
            if send(&sender, "snapshot", &snapshot(&current_turn, version))
                .await
                .is_err()
            {
                return;
            }
            let mut keepalive = tokio::time::interval(Duration::from_secs(15));
            keepalive.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            let deadline = tokio::time::Instant::now() + STREAM_IDLE;
            loop {
                tokio::select! {
                    event = rx.recv() => {
                        let v = now_ms();
                        match event {
                            Ok(super::hub::HubEvent::Delta(text)) => {
                                let event = json!({ "text": text, "version": v });
                                if send(&sender, "delta", &event).await.is_err() {
                                    return;
                                }
                            }
                            Ok(super::hub::HubEvent::Thinking) => {
                                let event = json!({ "status": "thinking", "version": v });
                                if send(&sender, "state", &event).await.is_err() {
                                    return;
                                }
                            }
                            Ok(super::hub::HubEvent::State(st)) => {
                                let event = json!({ "status": st.as_str(), "version": v });
                                if send(&sender, "state", &event).await.is_err() {
                                    return;
                                }
                            }
                            Ok(super::hub::HubEvent::Citations(cites)) => {
                                let event = json!({ "citations": cites, "version": v });
                                if send(&sender, "citations", &event).await.is_err() {
                                    return;
                                }
                            }
                            Ok(super::hub::HubEvent::Done) => {
                                let done = json!({ "version": v });
                                let _ = send(&sender, "done", &done).await;
                                return;
                            }
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                                if let Ok(Some(cur)) = store::turn(&worker.db, &key, &user_id, &id, &turn_id_str).await {
                                    let mut s = snapshot(&cur, v);
                                    let live = hub.current_answer();
                                    if !live.is_empty() {
                                        s["answer"] = json!(live);
                                    }
                                    if send(&sender, "snapshot", &s).await.is_err() {
                                        return;
                                    }
                                }
                            }
                            Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                                if let Ok(Some(cur)) = store::turn(&worker.db, &key, &user_id, &id, &turn_id_str).await {
                                    let _ = send(&sender, "snapshot", &snapshot(&cur, v)).await;
                                    if !cur.citations.is_empty() {
                                        let _ = send(&sender, "citations", &json!({ "citations": cur.citations, "version": v })).await;
                                    }
                                }
                                let _ = send(&sender, "done", &json!({ "version": v })).await;
                                return;
                            }
                        }
                    }
                    _ = keepalive.tick() => {
                        if sender.send(Ok(": keep-alive\n\n".to_owned())).await.is_err() {
                            return;
                        }
                    }
                    _ = tokio::time::sleep_until(deadline) => {
                        let _ = send(&sender, "done", &json!({ "version": now_ms() })).await;
                        return;
                    }
                }
            }
        } else {
            if send(&sender, "snapshot", &snapshot(&turn, version))
                .await
                .is_err()
            {
                return;
            }
            if !turn.citations.is_empty() {
                let _ = send(
                    &sender,
                    "citations",
                    &json!({ "citations": turn.citations, "version": version }),
                )
                .await;
            }
            let _ = send(&sender, "done", &json!({ "version": version })).await;
        }
    });
    let stream = futures_util::stream::unfold(receiver, |mut receiver| async move {
        match receiver.recv().await {
            Some(Ok(frame)) => Some((Ok::<_, Infallible>(frame), receiver)),
            _ => None,
        }
    });
    let body = Body::from_stream(stream);
    Ok(no_store(
        Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/event-stream")
            .header(header::CACHE_CONTROL, "private, no-store")
            .header(header::CONNECTION, "keep-alive")
            .header("x-accel-buffering", "no")
            .body(body)
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()),
    ))
}

/// Writes one event, keeping within the frame the reader accepts.
async fn send(
    sender: &tokio::sync::mpsc::Sender<Result<String, Infallible>>,
    name: &str,
    data: &Value,
) -> Result<(), ()> {
    let limits = Limits::default();
    let frame = format!("event: {name}\ndata: {data}\n\n");
    if frame.len() > limits.frame_bytes {
        // A frame this large cannot be delivered within the bound; the reader keeps the snapshot it
        // already has and reads the rest on the next connection.
        return Err(());
    }
    sender.send(Ok(frame)).await.map_err(|_| ())
}

fn snapshot(turn: &store::Turn, version: i64) -> Value {
    json!({
        "id": turn.id,
        "seq": turn.seq,
        "status": turn.state.as_str(),
        "answer": turn.answer,
        "citations": turn.citations,
        "partial": turn.partial,
        "provider": turn.provider,
        "model": turn.model,
        "effort": {
            "requested": turn.effort_requested,
            "sent": turn.effort_sent,
            "known": turn.effort_known,
        },
        "error": turn.error_code.as_ref().map(|code| json!({
            "code": code,
            "message": turn.error_message.clone().unwrap_or_default(),
        })),
        "version": version,
    })
}

/// POST /api/recordings/{id}/chat/turns/{turnId}/cancel
async fn stop(
    State(state): State<AppState>,
    user: CurrentUser,
    UrlPath((id, turn_id)): UrlPath<(String, String)>,
) -> ApiResult<Response> {
    if !recording_exists(&state, &user.id, &id).await? {
        return Err(no_recording());
    }
    let key = &state.config.field_key;
    let turn = store::turn(&state.db, key, &user.id, &id, &turn_id)
        .await?
        .ok_or_else(|| AppError::not_found("NOT_FOUND", "No such answer"))?;
    run::cancel(&turn_id);
    if !turn.state.is_final() {
        // The text written so far stays, and the state is final so nothing more is saved.
        store::end_run(
            &state.db,
            key,
            None,
            &turn_id,
            TurnState::Cancelled,
            None,
            None,
        )
        .await?;
    }
    Ok(no_store(Json(json!({ "success": true })).into_response()))
}

/// POST /api/recordings/{id}/chat/turns/{turnId}/retry
async fn retry(
    State(state): State<AppState>,
    user: CurrentUser,
    UrlPath((id, turn_id)): UrlPath<(String, String)>,
) -> ApiResult<Response> {
    if !recording_exists(&state, &user.id, &id).await? {
        return Err(no_recording());
    }
    let key = &state.config.field_key;
    let previous = store::turn(&state.db, key, &user.id, &id, &turn_id)
        .await?
        .ok_or_else(|| AppError::not_found("NOT_FOUND", "No such answer"))?;
    if !previous.state.is_final() {
        return Err(AppError::new(
            StatusCode::CONFLICT,
            "CONFLICT",
            "This answer is still running.",
        ));
    }
    // The new answer reads the transcript the old one was asked about, when it is still there.
    let previous_source: Option<String> = match previous.transcript_id.as_deref() {
        Some(tid) => sqlx::query_scalar(
            "SELECT source FROM transcriptions WHERE id = ? AND recording_id = ? AND user_id = ?",
        )
        .bind(tid)
        .bind(&id)
        .bind(&user.id)
        .fetch_optional(&state.db)
        .await?,
        None => None,
    };
    let source = source(&state, &user.id, &id, previous_source.as_deref())
        .await?
        .ok_or_else(|| invalid("transcribe the recording first").detail("field", "transcript"))?;
    let chat = store::conversation_or_create(&state.db, &user.id, &id).await?;
    let provider_id = chat.preference.provider_id.clone();
    let mut provider = provider_for(&state, &user.id, provider_id.as_deref())
        .await?
        .ok_or_else(|| {
            AppError::bad_request(
                "AI_PROVIDER_NOT_CONFIGURED",
                "No AI provider can answer questions.",
            )
        })?;
    let effort_choice = chat.preference.effort.unwrap_or(EffortChoice::Default);
    let created = store::create_turn(
        &state.db,
        key,
        &NewTurn {
            chat_id: &chat.id,
            recording_id: &id,
            user_id: &user.id,
            request_id: &format!("retry_{}", crate::ids::new_id()),
            generation: chat.generation,
            question: &previous.question,
            revision: &source.revision.hash,
            transcript_id: Some(&source.revision.transcript_id),
        },
    )
    .await?;
    let turn = match created {
        Ok(turn) => turn,
        Err(TurnRefusal::Busy) => {
            return Err(AppError::new(
                StatusCode::CONFLICT,
                "CONFLICT",
                "An answer is already running.",
            ));
        }
        Err(TurnRefusal::Stale | TurnRefusal::Missing) => {
            return Err(AppError::new(
                StatusCode::CONFLICT,
                "REVISION_CHANGED",
                "The chat changed. Ask again.",
            ));
        }
    };
    let model = chat
        .preference
        .model
        .clone()
        .unwrap_or_else(|| provider.chat_model());
    let (effort, _known) = run::resolve_effort(effort_choice, &provider.name, &model);
    provider.model = Some(model);
    let history = history(&state, &chat.id, &source.revision.hash).await?;
    run::spawn(
        state.clone(),
        Job {
            recording_id: id.clone(),
            user_id: user.id.clone(),
            turn_id: turn.id.clone(),
            generation: chat.generation,
            attempt: turn.attempt,
            revision: source.revision.clone(),
            question: previous.question.clone(),
            history,
            provider,
            effort_choice,
            effort,
            units: source.units,
            whole: run::asks_about_whole(&previous.question),
        },
    );
    Ok(no_store(
        (
            StatusCode::ACCEPTED,
            Json(json!({ "turn": store::turn_json(&turn) })),
        )
            .into_response(),
    ))
}

/// GET /api/recordings/{id}/chat/turns/{turnId}/citations/{sourceId}
async fn resolve_citation(
    State(state): State<AppState>,
    user: CurrentUser,
    UrlPath((id, turn_id, source_id)): UrlPath<(String, String, String)>,
) -> ApiResult<Response> {
    if !recording_exists(&state, &user.id, &id).await? {
        return Err(no_recording());
    }
    let key = &state.config.field_key;
    let turn = store::turn(&state.db, key, &user.id, &id, &turn_id)
        .await?
        .ok_or_else(|| AppError::not_found("NOT_FOUND", "No such answer"))?;

    let citation = turn
        .citations
        .iter()
        .find(|c| c.source_id == source_id)
        .ok_or_else(|| AppError::not_found("NOT_FOUND", "No such citation in this answer"))?;

    // The transcript the answer was given from. A citation of a transcript that is gone, or that
    // changed since, keeps its text and points nowhere.
    let row: Option<TranscriptRow> =
        match turn.transcript_id.as_deref() {
            Some(tid) => sqlx::query_as(
                "SELECT id, source, text, timeline, timeline_source, created_at FROM transcriptions
                 WHERE id = ? AND recording_id = ? AND user_id = ?",
            )
            .bind(tid)
            .bind(&id)
            .bind(&user.id)
            .fetch_optional(&state.db)
            .await?,
            None => None,
        };
    let Some(row) = row else {
        return Err(AppError::not_found(
            "NOT_FOUND",
            "Transcript no longer exists",
        ));
    };
    let text = key.decrypt(&row.text).map_err(AppError::internal)?;
    let timeline = row
        .timeline
        .as_deref()
        .map(serde_json::from_str::<Value>)
        .transpose()
        .map_err(AppError::internal)?
        .map(|value| key.decrypt_json(&value).map_err(AppError::internal))
        .transpose()?;
    let transcript = Transcript {
        id: row.id.clone(),
        source: row.source.clone(),
        text,
        timeline,
        timeline_source: row.timeline_source,
        created_at: row.created_at,
    };
    let revision = Revision::of(&user.id, &id, &transcript);
    let current = revision.hash == turn.revision;
    let shown = if current {
        citation.clone()
    } else {
        citation.text_only()
    };

    Ok(no_store(
        Json(json!({
            "recordingId": id,
            "turnId": turn_id,
            "sourceId": source_id,
            "transcriptId": row.id,
            "source": row.source,
            "revision": turn.revision,
            "current": current,
            "quote": shown.quote,
            "speaker": shown.speaker,
            "startMs": shown.start_ms,
            "endMs": shown.end_ms,
            "approximate": shown.approximate,
            "segmentStart": shown.segment_start,
            "segmentEnd": shown.segment_end,
            "line": shown.line,
            "lineStart": shown.line_start,
            "lineEnd": shown.line_end,
        }))
        .into_response(),
    ))
}

fn no_store(mut response: Response) -> Response {
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("private, no-store"),
    );
    response
}

fn invalid(message: &'static str) -> AppError {
    AppError::bad_request("INVALID_INPUT", message)
}
