//! Conversations and turns in SQLite (spec/recording-chat.md "Endpoints").
//!
//! Every write a run makes is fenced: it names the conversation generation, the turn, the attempt,
//! the revision and the lease it was started with, and it lands only while all of those still
//! match. That is what keeps a stopped, cleared or replaced run from saving over newer state.
//! Reads decrypt with the instance key, like transcripts and summaries.

use serde_json::Value;
use sqlx::Row as _;
use sqlx::SqlitePool;
use sqlx::sqlite::SqliteRow;

use crate::crypto::FieldKey;
use crate::db::now_ms;
use crate::time::iso;

use super::capabilities::EffortChoice;
use super::citations::{Citation, Stored};
use super::revision::Revision;

/// How many turns one page of history holds.
pub const PAGE_TURNS: i64 = 50;

/// A turn's state. The last five never change again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnState {
    Pending,
    Running,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
    Stale,
}

impl TurnState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Interrupted => "interrupted",
            Self::Stale => "stale",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "pending" => Self::Pending,
            "running" => Self::Running,
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            "interrupted" => Self::Interrupted,
            "stale" => Self::Stale,
            _ => return None,
        })
    }

    /// A state nothing may move out of.
    pub fn is_final(self) -> bool {
        !matches!(self, Self::Pending | Self::Running)
    }
}

/// The model preference stored on a conversation, used for the next send.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Preference {
    pub provider_id: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub effort: Option<EffortChoice>,
}

/// The conversation row.
#[derive(Debug, Clone)]
pub struct Conversation {
    pub id: String,
    pub generation: i64,
    pub preference: Preference,
}

/// One turn, with its stored text opened.
#[derive(Debug, Clone)]
pub struct Turn {
    pub id: String,
    pub seq: i64,
    pub state: TurnState,
    pub question: String,
    pub answer: String,
    pub citations: Vec<Citation>,
    /// True when only part of the transcript was read for this answer.
    pub partial: bool,
    pub revision: String,
    pub transcript_id: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub effort_requested: Option<String>,
    pub effort_sent: Option<String>,
    pub effort_known: bool,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub attempt: i64,
    pub created_at: i64,
    pub finished_at: Option<i64>,
}

/// A turn waiting to be written: what a submit creates.
pub struct NewTurn<'a> {
    pub chat_id: &'a str,
    pub recording_id: &'a str,
    pub user_id: &'a str,
    pub request_id: &'a str,
    pub generation: i64,
    pub question: &'a str,
    pub revision: &'a str,
    pub transcript_id: Option<&'a str>,
}

/// Why a turn could not be created.
#[derive(Debug, PartialEq, Eq)]
pub enum TurnRefusal {
    /// The conversation moved on: cleared, or a newer revision.
    Stale,
    /// Another answer is already running in this conversation.
    Busy,
    /// No conversation with that id for this user and recording.
    Missing,
}

/// A run's identity: everything a save must still match.
#[derive(Debug, Clone)]
pub struct Fence<'a> {
    pub turn_id: &'a str,
    pub generation: i64,
    pub attempt: i64,
    pub revision: &'a str,
    pub lease_owner: &'a str,
}

impl Fence<'_> {
    /// The condition every save of this run carries. Its placeholders, in order, are the turn id,
    /// the generation, the attempt, the revision, the lease owner and the lease deadline.
    fn condition(&self) -> &'static str {
        "id = ? AND generation = ? AND attempt = ? AND revision = ? AND lease_owner = ?
         AND lease_until > ? AND status IN ('pending', 'running')"
    }
}

/// Finds the conversation for a recording, if this user has one.
pub async fn conversation(
    db: &SqlitePool,
    user_id: &str,
    recording_id: &str,
) -> Result<Option<Conversation>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT id, generation, provider_id, provider, model, reasoning FROM recording_chats
         WHERE recording_id = ? AND user_id = ?",
    )
    .bind(recording_id)
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let effort = row
        .get::<Option<String>, _>("reasoning")
        .as_deref()
        .and_then(EffortChoice::parse);
    Ok(Some(Conversation {
        id: row.get("id"),
        generation: row.get("generation"),
        preference: Preference {
            provider_id: row.get("provider_id"),
            provider: row.get("provider"),
            model: row.get("model"),
            effort,
        },
    }))
}

/// Finds the conversation, creating it when it does not exist yet.
pub async fn conversation_or_create(
    db: &SqlitePool,
    user_id: &str,
    recording_id: &str,
) -> Result<Conversation, sqlx::Error> {
    if let Some(chat) = conversation(db, user_id, recording_id).await? {
        return Ok(chat);
    }
    let now = now_ms();
    // A second request in the same moment must not fail: the insert is skipped on a conflict and
    // the row is read back either way.
    sqlx::query(
        "INSERT INTO recording_chats (id, recording_id, user_id, generation, created_at, updated_at)
         VALUES (?, ?, ?, 0, ?, ?) ON CONFLICT(recording_id, user_id) DO NOTHING",
    )
    .bind(crate::ids::new_id())
    .bind(recording_id)
    .bind(user_id)
    .bind(now)
    .bind(now)
    .execute(db)
    .await?;
    conversation(db, user_id, recording_id)
        .await?
        .ok_or(sqlx::Error::RowNotFound)
}

/// Saves the preference for the next send.
pub async fn save_preference(
    db: &SqlitePool,
    user_id: &str,
    recording_id: &str,
    preference: &Preference,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE recording_chats SET provider_id = ?, provider = ?, model = ?, reasoning = ?,
         updated_at = ? WHERE recording_id = ? AND user_id = ?",
    )
    .bind(preference.provider_id.as_deref())
    .bind(preference.provider.as_deref())
    .bind(preference.model.as_deref())
    .bind(preference.effort.map(EffortChoice::as_str))
    .bind(now_ms())
    .bind(recording_id)
    .bind(user_id)
    .execute(db)
    .await?;
    Ok(())
}

/// The turn a repeated `requestId` already created.
pub async fn turn_by_request(
    db: &SqlitePool,
    key: &FieldKey,
    chat_id: &str,
    request_id: &str,
) -> Result<Option<Turn>, sqlx::Error> {
    let row =
        sqlx::query("SELECT * FROM recording_chat_turns WHERE chat_id = ? AND request_id = ?")
            .bind(chat_id)
            .bind(request_id)
            .fetch_optional(db)
            .await?;
    row.map(|row| turn_from_row(key, row)).transpose()
}

/// Creates a turn. Only one turn per conversation may be active, and an old generation is refused.
pub async fn create_turn(
    db: &SqlitePool,
    key: &FieldKey,
    new: &NewTurn<'_>,
) -> Result<Result<Turn, TurnRefusal>, sqlx::Error> {
    let mut tx = db.begin().await?;
    let current: Option<i64> =
        sqlx::query_scalar("SELECT generation FROM recording_chats WHERE id = ? AND user_id = ?")
            .bind(new.chat_id)
            .bind(new.user_id)
            .fetch_optional(&mut *tx)
            .await?;
    let Some(generation) = current else {
        return Ok(Err(TurnRefusal::Missing));
    };
    if generation != new.generation {
        return Ok(Err(TurnRefusal::Stale));
    }
    let busy: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM recording_chat_turns WHERE chat_id = ? AND status IN ('pending', 'running')",
    )
    .bind(new.chat_id)
    .fetch_one(&mut *tx)
    .await?;
    if busy > 0 {
        return Ok(Err(TurnRefusal::Busy));
    }
    let seq: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(seq), 0) + 1 FROM recording_chat_turns WHERE chat_id = ?",
    )
    .bind(new.chat_id)
    .fetch_one(&mut *tx)
    .await?;
    let now = now_ms();
    let id = crate::ids::new_id();
    sqlx::query(
        "INSERT INTO recording_chat_turns
         (id, chat_id, recording_id, user_id, request_id, seq, status, generation, attempt, question,
          revision, transcript_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 1, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(new.chat_id)
    .bind(new.recording_id)
    .bind(new.user_id)
    .bind(new.request_id)
    .bind(seq)
    .bind(new.generation)
    .bind(key.encrypt(new.question))
    .bind(new.revision)
    .bind(new.transcript_id)
    .bind(now)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Ok(Turn {
        id,
        seq,
        state: TurnState::Pending,
        question: new.question.to_owned(),
        answer: String::new(),
        citations: Vec::new(),
        partial: false,
        revision: new.revision.to_owned(),
        transcript_id: new.transcript_id.map(str::to_owned),
        provider: None,
        model: None,
        effort_requested: None,
        effort_sent: None,
        effort_known: false,
        error_code: None,
        error_message: None,
        attempt: 1,
        created_at: now,
        finished_at: None,
    }))
}

/// The newest page of turns, newest first. `before` pages further back by `seq`.
pub async fn recent_turns(
    db: &SqlitePool,
    key: &FieldKey,
    chat_id: &str,
    before: Option<i64>,
) -> Result<Vec<Turn>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT * FROM recording_chat_turns WHERE chat_id = ? AND (? IS NULL OR seq < ?)
         ORDER BY seq DESC LIMIT ?",
    )
    .bind(chat_id)
    .bind(before)
    .bind(before)
    .bind(PAGE_TURNS)
    .fetch_all(db)
    .await?;
    rows.into_iter()
        .map(|row| turn_from_row(key, row))
        .collect()
}

/// One turn, if it belongs to the user and recording.
pub async fn turn(
    db: &SqlitePool,
    key: &FieldKey,
    user_id: &str,
    recording_id: &str,
    turn_id: &str,
) -> Result<Option<Turn>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT * FROM recording_chat_turns WHERE id = ? AND user_id = ? AND recording_id = ?",
    )
    .bind(turn_id)
    .bind(user_id)
    .bind(recording_id)
    .fetch_optional(db)
    .await?;
    row.map(|row| turn_from_row(key, row)).transpose()
}

/// The turn in `pending` or `running`, if any.
pub async fn active_turn(
    db: &SqlitePool,
    key: &FieldKey,
    chat_id: &str,
) -> Result<Option<Turn>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT * FROM recording_chat_turns WHERE chat_id = ? AND status IN ('pending', 'running') LIMIT 1",
    )
    .bind(chat_id)
    .fetch_optional(db)
    .await?;
    row.map(|row| turn_from_row(key, row)).transpose()
}

/// Takes the lease and moves the turn to `running`, recording the model and effort used.
///
/// The update lands only while the turn is still `pending` in the generation, attempt and revision
/// it was created with, so a run for a cleared conversation cannot start.
#[allow(clippy::too_many_arguments)]
pub async fn start_run(
    db: &SqlitePool,
    turn_id: &str,
    generation: i64,
    attempt: i64,
    revision: &str,
    lease_owner: &str,
    lease_until: i64,
    model_note: &ModelNote<'_>,
) -> Result<bool, sqlx::Error> {
    let now = now_ms();
    let result = sqlx::query(
        "UPDATE recording_chat_turns
         SET status = 'running', lease_owner = ?, lease_until = ?, provider = ?, model = ?,
             reasoning_requested = ?, reasoning_sent = ?, reasoning_known = ?, updated_at = ?
         WHERE id = ? AND generation = ? AND attempt = ? AND revision = ? AND status = 'pending'",
    )
    .bind(lease_owner)
    .bind(lease_until)
    .bind(model_note.provider)
    .bind(model_note.model)
    .bind(model_note.effort_requested)
    .bind(model_note.effort_sent)
    .bind(i64::from(model_note.effort_known))
    .bind(now)
    .bind(turn_id)
    .bind(generation)
    .bind(attempt)
    .bind(revision)
    .execute(db)
    .await?;
    Ok(result.rows_affected() == 1)
}

/// What a turn records about the model and effort it runs with.
pub struct ModelNote<'a> {
    pub provider: Option<&'a str>,
    pub model: Option<&'a str>,
    pub effort_requested: Option<&'a str>,
    pub effort_sent: Option<&'a str>,
    pub effort_known: bool,
}

/// Renews the lease. False when the run no longer holds it, which means it must stop.
pub async fn renew_lease(
    db: &SqlitePool,
    fence: &Fence<'_>,
    lease_until: i64,
) -> Result<bool, sqlx::Error> {
    let result = sqlx::query(
        "UPDATE recording_chat_turns SET lease_until = ?, updated_at = ?
         WHERE id = ? AND generation = ? AND attempt = ? AND revision = ? AND lease_owner = ?
           AND status IN ('pending', 'running')",
    )
    .bind(lease_until)
    .bind(now_ms())
    .bind(fence.turn_id)
    .bind(fence.generation)
    .bind(fence.attempt)
    .bind(fence.revision)
    .bind(fence.lease_owner)
    .execute(db)
    .await?;
    Ok(result.rows_affected() == 1)
}

/// Saves the text written so far, and the citations when they are already known.
/// False when the fence no longer holds.
pub async fn save_partial(
    db: &SqlitePool,
    key: &FieldKey,
    fence: &Fence<'_>,
    answer: &str,
    citations: Option<&[Citation]>,
) -> Result<bool, sqlx::Error> {
    let now = now_ms();
    let condition = fence.condition();
    let result = match citations {
        Some(citations) => {
            let value = Stored {
                citations: citations.to_vec(),
                partial: false,
            }
            .to_value();
            let sql = format!(
                "UPDATE recording_chat_turns SET answer = ?, citations = ?, updated_at = ?
                 WHERE {condition}"
            );
            sqlx::query(&sql)
                .bind(key.encrypt(answer))
                .bind(key.encrypt_json(&value).to_string())
                .bind(now)
                .bind(fence.turn_id)
                .bind(fence.generation)
                .bind(fence.attempt)
                .bind(fence.revision)
                .bind(fence.lease_owner)
                .bind(now)
                .execute(db)
                .await?
        }
        None => {
            let sql = format!(
                "UPDATE recording_chat_turns SET answer = ?, updated_at = ? WHERE {condition}"
            );
            sqlx::query(&sql)
                .bind(key.encrypt(answer))
                .bind(now)
                .bind(fence.turn_id)
                .bind(fence.generation)
                .bind(fence.attempt)
                .bind(fence.revision)
                .bind(fence.lease_owner)
                .bind(now)
                .execute(db)
                .await?
        }
    };
    Ok(result.rows_affected() == 1)
}

/// Saves the answer with its citations and finishes the turn. False when the fence no longer holds.
pub async fn finish(
    db: &SqlitePool,
    key: &FieldKey,
    fence: &Fence<'_>,
    answer: &str,
    citations: &[Citation],
) -> Result<bool, sqlx::Error> {
    let now = now_ms();
    let value = Stored {
        citations: citations.to_vec(),
        partial: false,
    }
    .to_value();
    let sql = format!(
        "UPDATE recording_chat_turns
         SET status = 'completed', answer = ?, citations = ?, error_code = NULL,
             error_message = NULL, lease_owner = NULL, lease_until = NULL, finished_at = ?,
             updated_at = ?
         WHERE {}",
        fence.condition()
    );
    let result = sqlx::query(&sql)
        .bind(key.encrypt(answer))
        .bind(key.encrypt_json(&value).to_string())
        .bind(now)
        .bind(now)
        .bind(fence.turn_id)
        .bind(fence.generation)
        .bind(fence.attempt)
        .bind(fence.revision)
        .bind(fence.lease_owner)
        .bind(now)
        .execute(db)
        .await?;
    Ok(result.rows_affected() == 1)
}

/// Ends a turn without a completed answer: a failure, a stop, or an interruption.
///
/// A final state is never written twice, so a late failure cannot overwrite a completed answer.
/// With no fence, the turn is ended whoever holds it, which is what a stop from a request does.
pub async fn end_run(
    db: &SqlitePool,
    key: &FieldKey,
    fence: Option<&Fence<'_>>,
    turn_id: &str,
    state: TurnState,
    code: Option<&str>,
    message: Option<&str>,
) -> Result<bool, sqlx::Error> {
    if !state.is_final() || state == TurnState::Completed {
        return Ok(false);
    }
    let now = now_ms();
    let message = message.map(|m| key.encrypt(m));
    let result = match fence {
        Some(fence) => {
            let sql = format!(
                "UPDATE recording_chat_turns
                 SET status = ?, error_code = ?, error_message = ?, lease_owner = NULL,
                     lease_until = NULL, finished_at = ?, updated_at = ?
                 WHERE {}",
                fence.condition()
            );
            sqlx::query(&sql)
                .bind(state.as_str())
                .bind(code)
                .bind(message)
                .bind(now)
                .bind(now)
                .bind(fence.turn_id)
                .bind(fence.generation)
                .bind(fence.attempt)
                .bind(fence.revision)
                .bind(fence.lease_owner)
                .bind(now)
                .execute(db)
                .await?
        }
        None => {
            sqlx::query(
                "UPDATE recording_chat_turns
                 SET status = ?, error_code = ?, error_message = ?, lease_owner = NULL,
                     lease_until = NULL, finished_at = ?, updated_at = ?
                 WHERE id = ? AND status IN ('pending', 'running')",
            )
            .bind(state.as_str())
            .bind(code)
            .bind(message)
            .bind(now)
            .bind(now)
            .bind(turn_id)
            .execute(db)
            .await?
        }
    };
    Ok(result.rows_affected() == 1)
}

/// Moves the conversation forward so every run of an older generation can no longer save.
pub async fn clear(db: &SqlitePool, user_id: &str, recording_id: &str) -> Result<(), sqlx::Error> {
    let mut tx = db.begin().await?;
    let chat_id: Option<String> =
        sqlx::query_scalar("SELECT id FROM recording_chats WHERE recording_id = ? AND user_id = ?")
            .bind(recording_id)
            .bind(user_id)
            .fetch_optional(&mut *tx)
            .await?;
    let Some(chat_id) = chat_id else {
        return Ok(());
    };
    let now = now_ms();
    sqlx::query("DELETE FROM recording_chat_turns WHERE chat_id = ?")
        .bind(&chat_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "UPDATE recording_chats SET generation = generation + 1, updated_at = ? WHERE id = ?",
    )
    .bind(now)
    .bind(&chat_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

/// Ends the turns a previous process left running. Nothing is sent anywhere.
pub async fn interrupt_orphans(db: &SqlitePool, key: &FieldKey) -> Result<u64, sqlx::Error> {
    let now = now_ms();
    let result = sqlx::query(
        "UPDATE recording_chat_turns
         SET status = 'interrupted', error_code = 'CHAT_INTERRUPTED', error_message = ?,
             lease_owner = NULL, lease_until = NULL, finished_at = ?, updated_at = ?
         WHERE status IN ('pending', 'running')",
    )
    .bind(key.encrypt("The answer stopped before it finished."))
    .bind(now)
    .bind(now)
    .execute(db)
    .await?;
    Ok(result.rows_affected())
}

fn turn_from_row(key: &FieldKey, row: SqliteRow) -> Result<Turn, sqlx::Error> {
    let decrypt = |value: Option<String>| -> Result<String, sqlx::Error> {
        match value {
            None => Ok(String::new()),
            Some(text) => key
                .decrypt(&text)
                .map_err(|e| sqlx::Error::Decode(Box::new(e))),
        }
    };
    // Citations are stored as the encrypted JSON envelope, so they are opened as JSON rather than
    // as a plain string.
    let stored = match row.get::<Option<String>, _>("citations") {
        Some(text) => {
            let envelope: Value = serde_json::from_str(&text).unwrap_or(Value::Array(Vec::new()));
            let value = key
                .decrypt_json(&envelope)
                .map_err(|e| sqlx::Error::Decode(Box::new(e)))?;
            super::citations::from_stored(&value)
        }
        None => Stored::default(),
    };
    let error_message = row
        .get::<Option<String>, _>("error_message")
        .map(|text| decrypt(Some(text)))
        .transpose()?;
    Ok(Turn {
        id: row.get("id"),
        seq: row.get("seq"),
        // An unreadable state is treated as interrupted: it is final, so nothing keeps writing.
        state: TurnState::parse(&row.get::<String, _>("status")).unwrap_or(TurnState::Interrupted),
        question: decrypt(Some(row.get("question")))?,
        answer: decrypt(row.get::<Option<String>, _>("answer"))?,
        citations: stored.citations,
        partial: stored.partial,
        revision: row.get("revision"),
        transcript_id: row.get("transcript_id"),
        provider: row.get("provider"),
        model: row.get("model"),
        effort_requested: row.get("reasoning_requested"),
        effort_sent: row.get("reasoning_sent"),
        effort_known: row.get::<i64, _>("reasoning_known") != 0,
        error_code: row.get("error_code"),
        error_message,
        attempt: row.get("attempt"),
        created_at: row.get("created_at"),
        finished_at: row.get("finished_at"),
    })
}

/// A turn as the API returns it.
pub fn turn_json(turn: &Turn) -> Value {
    serde_json::json!({
        "id": turn.id,
        "seq": turn.seq,
        "status": turn.state.as_str(),
        "question": turn.question,
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
        "error": turn.error_code.as_ref().map(|code| serde_json::json!({
            "code": code,
            "message": turn.error_message.clone().unwrap_or_default(),
        })),
        "createdAt": iso(turn.created_at),
        "finishedAt": turn.finished_at.map(iso),
    })
}

/// A turn as the API returns it, against the transcript that is current now.
///
/// A citation points into the transcript it was answered from. When that is no longer the
/// recording's transcript, the citation keeps its text and loses every link into the transcript,
/// so nothing on screen claims a moment or a row of words that may have changed.
pub fn turn_json_for(turn: &Turn, revision: Option<&Revision>) -> Value {
    let mut body = turn_json(turn);
    let same_revision = revision.is_some_and(|current| current.hash == turn.revision);
    body["current"] = Value::Bool(same_revision);
    if !same_revision {
        let cleared: Vec<Citation> = turn.citations.iter().map(Citation::text_only).collect();
        body["citations"] = serde_json::to_value(cleared).unwrap_or(Value::Array(Vec::new()));
    }
    body
}

/// The transcript in use, as the API describes it.
pub fn transcript_json(revision: &Revision, created_at: i64) -> Value {
    serde_json::json!({
        "id": revision.transcript_id,
        "source": revision.source,
        "hasTimeline": revision.timing.has_time(),
        "timelineSource": revision.timing.as_str(),
        "createdAt": iso(created_at),
    })
}

/// Finishes a turn that this process ran, checking the generation, attempt and revision that the
/// run started with. The lease is not part of the check here: it was validated at every checkpoint,
/// and the final save is what ends it.
#[allow(clippy::too_many_arguments)]
pub async fn finish_unfenced(
    db: &SqlitePool,
    key: &FieldKey,
    turn_id: &str,
    generation: i64,
    attempt: i64,
    revision: &str,
    answer: &str,
    stored: &Stored,
) -> Result<bool, sqlx::Error> {
    let now = now_ms();
    let value = stored.to_value();
    let result = sqlx::query(
        "UPDATE recording_chat_turns
         SET status = 'completed', answer = ?, citations = ?, error_code = NULL,
             error_message = NULL, lease_owner = NULL, lease_until = NULL, finished_at = ?,
             updated_at = ?
         WHERE id = ? AND generation = ? AND attempt = ? AND revision = ?
           AND status IN ('pending', 'running')",
    )
    .bind(key.encrypt(answer))
    .bind(key.encrypt_json(&value).to_string())
    .bind(now)
    .bind(now)
    .bind(turn_id)
    .bind(generation)
    .bind(attempt)
    .bind(revision)
    .execute(db)
    .await?;
    Ok(result.rows_affected() == 1)
}
