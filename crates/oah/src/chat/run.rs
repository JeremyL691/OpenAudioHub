//! Running one answer: who may run, what it sends, and what it may save
//! (spec/recording-chat.md "Worker behaviour", "Limits", "What the model receives").
//!
//! A run belongs to the server process that accepted it. It holds a lease, renews it from its own
//! loop, and stops the moment the lease, the generation or the revision stops matching. Nothing
//! here is a queued job, so no other worker ever picks a half-finished answer up and pays twice.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tokio::sync::watch;

use crate::AppState;
use crate::db::now_ms;

use super::capabilities::{Effort, EffortChoice, EffortDecision, resolve, support_for};
use super::citations::{Stored, verify};
use super::context::Unit;
use super::revision::Revision;
use super::store::{self, Fence, ModelNote, TurnState};
use super::stream::{self, Limits};

/// The lease a run holds, how often it renews it, and how often it saves the text so far.
pub const LEASE_MS: i64 = 45_000;
const RENEW: Duration = Duration::from_secs(10);
const CHECKPOINT: Duration = Duration::from_millis(500);
/// The wall clock of one turn, and of one provider call.
const TURN_LIMIT: Duration = Duration::from_secs(900);
const CALL_LIMIT: Duration = Duration::from_secs(300);
/// The most provider requests and reserved tokens one turn may use.
const MAX_CALLS: usize = 32;
const MAX_INPUT_TOKENS: usize = 512_000;
const MAX_OUTPUT_TOKENS: usize = 128_000;
const MAX_CALL_OUTPUT: u32 = 16_384;
const MIN_OUTPUT_TOKENS: u32 = 4_096;
/// The output budget of one part read while answering about a whole recording. A thinking model
/// spends part of it before it writes, so it is well above what the notes themselves need.
const NOTE_OUTPUT: u32 = 8_192;
/// The most transcript one part holds, in estimated tokens, so a part is read closely.
const NOTE_PART_TOKENS: usize = 60_000;
/// The budget used for a model whose context size is not known.
const UNKNOWN_CONTEXT_TOKENS: usize = 8_000;
const TEMPERATURE: f64 = 0.5;
/// The most earlier turns a question is read with, and the characters they may take.
pub const HISTORY_TURNS: usize = 12;
const HISTORY_CHARS: usize = 12_000;
const NOTE_TEMPERATURE: f64 = 0.2;

struct Run {
    cancel: watch::Sender<bool>,
}

fn runs() -> &'static Mutex<HashMap<String, Run>> {
    static RUNS: OnceLock<Mutex<HashMap<String, Run>>> = OnceLock::new();
    RUNS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Stops the run of one turn, when this process holds it.
pub fn cancel(turn_id: &str) {
    let sender = runs()
        .lock()
        .ok()
        .and_then(|runs| runs.get(turn_id).map(|run| run.cancel.clone()));
    if let Some(sender) = sender {
        let _ = sender.send(true);
    }
}

/// True while this process runs that turn.
pub fn is_running(turn_id: &str) -> bool {
    runs()
        .lock()
        .map(|runs| runs.contains_key(turn_id))
        .unwrap_or(false)
}

fn register(turn_id: &str) -> watch::Receiver<bool> {
    let (sender, receiver) = watch::channel(false);
    if let Ok(mut runs) = runs().lock() {
        runs.insert(turn_id.to_owned(), Run { cancel: sender });
    }
    receiver
}

fn unregister(turn_id: &str) {
    if let Ok(mut runs) = runs().lock() {
        runs.remove(turn_id);
    }
}

/// What a run is given when it starts.
pub struct Job {
    pub recording_id: String,
    pub user_id: String,
    pub turn_id: String,
    pub generation: i64,
    pub attempt: i64,
    pub revision: Revision,
    pub question: String,
    /// Earlier questions and answers of the same revision, oldest first.
    pub history: Vec<(String, String)>,
    pub provider: crate::ai::Provider,
    /// What the user chose, kept for the record.
    pub effort_choice: EffortChoice,
    /// What that choice resolves to on this model.
    pub effort: EffortDecision,
    /// The units of this revision an answer may cite, in transcript order.
    pub units: Vec<Unit>,
    /// True when the question is about the recording as a whole.
    pub whole: bool,
}

/// Starts a run in the background and returns at once.
pub fn spawn(state: AppState, job: Job) {
    let turn_id = job.turn_id.clone();
    tokio::spawn(async move {
        let hub = super::hub::register(&turn_id);
        let mut stop = register(&turn_id);
        let outcome = tokio::select! {
            outcome = run(&state, &job, &mut stop, hub.clone()) => outcome,
            _ = tokio::time::sleep(TURN_LIMIT) => Outcome::failed(
                "AI_PROVIDER_TIMEOUT",
                "This answer took longer than this app allows.",
            ),
        };
        save(&state, &job, outcome, hub).await;
        super::hub::unregister(&turn_id);
        unregister(&turn_id);
    });
}

/// How a run ended.
struct Outcome {
    answer: String,
    /// True when only part of the transcript was read for this answer.
    partial: bool,
    failure: Option<(&'static str, String)>,
    stopped: bool,
}

impl Outcome {
    fn failed(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            answer: String::new(),
            partial: false,
            failure: Some((code, message.into())),
            stopped: false,
        }
    }
}

/// The provider calls one turn made, and the tokens it reserved.
struct Budget {
    calls: usize,
    input_tokens: usize,
    output_tokens: usize,
}

impl Budget {
    fn new() -> Self {
        Self {
            calls: 0,
            input_tokens: 0,
            output_tokens: 0,
        }
    }

    /// Counts one call before it is sent, so a refusal costs nothing and no call goes uncounted.
    fn reserve(&mut self, input: usize, output: u32) -> Result<(), (&'static str, String)> {
        if self.calls >= MAX_CALLS {
            return Err((
                "CHAT_LIMIT_REACHED",
                "This question needed more model calls than this app allows.".to_owned(),
            ));
        }
        if self.input_tokens + input > MAX_INPUT_TOKENS
            || self.output_tokens + output as usize > MAX_OUTPUT_TOKENS
        {
            return Err((
                "CHAT_LIMIT_REACHED",
                "This question was too large for this app to answer in one go.".to_owned(),
            ));
        }
        self.calls += 1;
        self.input_tokens += input;
        self.output_tokens += output as usize;
        Ok(())
    }
}

/// What a run carries between its steps.
struct Session<'a> {
    state: &'a AppState,
    job: &'a Job,
    fence: Fence<'a>,
    effort: Option<Effort>,
    budget: Budget,
    context: usize,
    hub: Arc<super::hub::TurnHub>,
    /// The answer text as it is written, shared with the saving step.
    written: Arc<Mutex<String>>,
}

/// Runs one answer: reads the recording, then writes the answer.
async fn run(
    state: &AppState,
    job: &Job,
    stop: &mut watch::Receiver<bool>,
    hub: Arc<super::hub::TurnHub>,
) -> Outcome {
    let lease_owner = crate::ids::token_hex(8);
    let effort = match job.effort {
        EffortDecision::Send(level) | EffortDecision::Capped(level) => Some(level),
        EffortDecision::Default | EffortDecision::NotSupported | EffortDecision::Unknown => None,
    };
    let model = job.provider.chat_model();
    let started = store::start_run(
        &state.db,
        &job.turn_id,
        job.generation,
        job.attempt,
        &job.revision.hash,
        &lease_owner,
        now_ms() + LEASE_MS,
        &ModelNote {
            provider: Some(&job.provider.name),
            model: Some(&model),
            effort_requested: Some(job.effort_choice.as_str()),
            effort_sent: effort.map(Effort::as_str),
            effort_known: !matches!(job.effort, EffortDecision::Unknown),
        },
    )
    .await;
    if !matches!(started, Ok(true)) {
        // The turn moved on before this run began, so nothing may be written.
        return Outcome::failed(
            "CHAT_INTERRUPTED",
            "This answer was replaced before it started.",
        );
    }
    let fence = Fence {
        turn_id: &job.turn_id,
        generation: job.generation,
        attempt: job.attempt,
        revision: &job.revision.hash,
        lease_owner: &lease_owner,
    };
    let context = super::capabilities::context_window(&job.provider.name, &model)
        .unwrap_or(UNKNOWN_CONTEXT_TOKENS);
    let mut session = Session {
        state,
        job,
        fence,
        effort,
        budget: Budget::new(),
        context,
        hub,
        written: Arc::new(Mutex::new(String::new())),
    };

    if *stop.borrow() {
        return Outcome {
            answer: String::new(),
            partial: false,
            failure: None,
            stopped: true,
        };
    }
    let material = match material(&mut session).await {
        Ok(material) => material,
        Err(outcome) => return outcome,
    };
    if *stop.borrow() {
        return Outcome {
            answer: current(&session.written),
            partial: material.partial,
            failure: None,
            stopped: true,
        };
    }
    write(session, material, stop).await
}

/// What a question sends besides the recent conversation.
struct Material {
    /// The units the answer may cite, with their source ids.
    units: Vec<Unit>,
    /// Notes from reading the whole recording, when the question is about all of it.
    notes: Option<String>,
    /// True when the transcript was read in part rather than whole.
    partial: bool,
}

/// Builds what the model reads. A transcript that fits is sent whole; a long one is either
/// searched, or, for a question about the whole recording, read in parts.
async fn material(session: &mut Session<'_>) -> Result<Material, Outcome> {
    let units = &session.job.units;
    let empty = Material {
        units: Vec::new(),
        notes: None,
        partial: false,
    };
    // What the prompt, the recent conversation and the answer take, so the transcript gets the rest.
    let overhead = estimate_tokens(&answer_messages(session.job, &empty));
    let room = session
        .context
        .saturating_sub(overhead + answer_output(session.context) as usize);
    let rendered = render(units);
    let tokens = tokens_of(&rendered);
    if tokens <= room {
        return Ok(Material {
            units: units.clone(),
            ..empty
        });
    }
    if !session.job.whole {
        let chars_budget = chars_for(room, &rendered, tokens).max(1_500);
        let selection = super::context::select(&session.job.question, units, chars_budget);
        return Ok(Material {
            units: selection.units,
            notes: None,
            partial: true,
        });
    }
    let part_tokens = session
        .context
        .saturating_sub(NOTE_OUTPUT as usize + 1_000)
        .min(NOTE_PART_TOKENS);
    let group_chars = chars_for(part_tokens, &rendered, tokens).max(2_000);
    let notes = read_all(session, group_chars).await?;
    Ok(Material {
        notes: Some(notes),
        ..empty
    })
}

/// The units as the model reads them, one per line.
fn render(units: &[Unit]) -> String {
    units
        .iter()
        .map(Unit::render)
        .collect::<Vec<_>>()
        .join("\n")
}

/// The characters of this transcript that fit in `tokens`, from its own mix of scripts: Chinese
/// costs about a token a character, English about a token every four.
fn chars_for(tokens: usize, rendered: &str, rendered_tokens: usize) -> usize {
    let chars = rendered.chars().count();
    (tokens as f64 * chars as f64 / rendered_tokens.max(1) as f64) as usize
}

/// The output the answer may use: room for a thinking model to reason and still write, without
/// taking more than a quarter of a small context.
fn answer_output(context: usize) -> u32 {
    MAX_CALL_OUTPUT
        .min((context / 4) as u32)
        .max(MIN_OUTPUT_TOKENS)
}

/// Reads every part of a long recording, keeping the source ids each note came from.
async fn read_all(session: &mut Session<'_>, group_chars: usize) -> Result<String, Outcome> {
    let mut groups: Vec<Vec<&Unit>> = Vec::new();
    let mut current: Vec<&Unit> = Vec::new();
    let mut size = 0usize;
    for unit in &session.job.units {
        let chars = unit.render().chars().count() + 1;
        if size + chars > group_chars && !current.is_empty() {
            groups.push(std::mem::take(&mut current));
            size = 0;
        }
        size += chars;
        current.push(unit);
    }
    if !current.is_empty() {
        groups.push(current);
    }
    if groups.len() + 1 > MAX_CALLS {
        return Err(Outcome::failed(
            "CHAT_LIMIT_REACHED",
            "This recording is too long to read in one answer. Ask about a part of it instead.",
        ));
    }
    let total = groups.len();
    let mut notes = Vec::new();
    for (index, group) in groups.iter().enumerate() {
        let text = group
            .iter()
            .map(|unit| unit.render())
            .collect::<Vec<_>>()
            .join("\n");
        let messages = json!([
            {
                "role": "system",
                "content": "You read one part of a recording transcript. Each line starts with its source marker, such as [src_12], then the time it was said and the speaker when known. List the facts in this part that bear on the question as short bullet points. End every bullet with the marker of the exact line it came from, copied as written, such as [src_12]; use two or three markers only when the fact really spans those lines. If this part says nothing about the question, answer none. Do not add anything that is not in the text."
            },
            {
                "role": "user",
                "content": format!(
                    "Question: {}\n\nPart {}/{}:\n\n{text}",
                    session.job.question,
                    index + 1,
                    total
                )
            },
        ]);
        let input = estimate_tokens(&messages);
        if let Err((code, message)) = session.budget.reserve(input, NOTE_OUTPUT) {
            return Err(Outcome::failed(code, message));
        }
        let answer = call(session, &messages, NOTE_OUTPUT).await?;
        notes.push(format!(
            "Part {} of {}:\n{}",
            index + 1,
            total,
            answer.trim()
        ));
    }
    Ok(notes.join("\n\n"))
}

/// Writes the answer, streaming it into the saved text.
async fn write(
    session: Session<'_>,
    material: Material,
    stop: &mut watch::Receiver<bool>,
) -> Outcome {
    let messages = answer_messages(session.job, &material);
    let input = estimate_tokens(&messages);
    let room = session.context.saturating_sub(input);
    let mut budget = session.budget;
    let output = answer_output(session.context).min(room.max(MIN_OUTPUT_TOKENS as usize) as u32);
    if let Err((code, message)) = budget.reserve(input, output) {
        return Outcome::failed(code, message);
    }
    let key = &session.state.config.field_key;
    let sink = session.written.clone();
    let hub_delta = session.hub.clone();
    let hub_thinking = session.hub.clone();
    let call = stream::complete(
        &session.job.provider,
        &messages,
        session.effort,
        output,
        TEMPERATURE,
        CALL_LIMIT,
        Limits::default(),
        move |text| {
            if let Ok(mut buffer) = sink.lock() {
                buffer.push_str(text);
            }
            hub_delta.send(super::hub::HubEvent::Delta(text.to_owned()));
        },
        move || {
            hub_thinking.send(super::hub::HubEvent::Thinking);
        },
    );
    tokio::pin!(call);
    let mut tick = tokio::time::interval(CHECKPOINT);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last_saved = String::new();
    let mut last_renewal = Instant::now();
    loop {
        tokio::select! {
            result = &mut call => {
                return match result {
                    // A part-read answer is marked as such, so the interface can say so in the
                    // reader's language; the prompt already keeps it from speaking for the whole.
                    Ok(completion) => Outcome {
                        answer: completion.text,
                        partial: material.partial,
                        failure: None,
                        stopped: false,
                    },
                    Err(error) => Outcome {
                        answer: current(&session.written),
                        partial: material.partial,
                        failure: Some((error.code, error.message)),
                        stopped: false,
                    },
                };
            }
            _ = stop.changed() => {
                if *stop.borrow() {
                    let text = current(&session.written);
                    let _ = store::save_partial(&session.state.db, key, &session.fence, &text, None).await;
                    return Outcome { answer: text, partial: material.partial, failure: None, stopped: true };
                }
            }
            _ = tick.tick() => {
                let text = current(&session.written);
                if text != last_saved && !text.is_empty() {
                    let saved = store::save_partial(&session.state.db, key, &session.fence, &text, None).await.unwrap_or(false);
                    if !saved {
                        // Stopped, cleared or replaced: stop paying for this answer.
                        return Outcome::failed("CHAT_INTERRUPTED", "This answer was replaced while it was being written.");
                    }
                    last_saved = text;
                }
                if last_renewal.elapsed() >= RENEW {
                    last_renewal = Instant::now();
                    let held = store::renew_lease(&session.state.db, &session.fence, now_ms() + LEASE_MS).await.unwrap_or(false);
                    if !held {
                        return Outcome::failed("CHAT_INTERRUPTED", "This answer lost its place and stopped.");
                    }
                }
            }
        }
    }
}

/// One provider call whose text is read whole, for a part of the recording.
async fn call(session: &Session<'_>, messages: &Value, output: u32) -> Result<String, Outcome> {
    match stream::complete(
        &session.job.provider,
        messages,
        session.effort,
        output,
        NOTE_TEMPERATURE,
        CALL_LIMIT,
        Limits::default(),
        |_| {},
        || {},
    )
    .await
    {
        Ok(completion) => Ok(completion.text),
        Err(error) => Err(Outcome::failed(error.code, error.message)),
    }
}

fn current(shared: &Arc<Mutex<String>>) -> String {
    shared.lock().map(|text| text.clone()).unwrap_or_default()
}

/// The chat messages for the final answer.
fn answer_messages(job: &Job, material: &Material) -> Value {
    let mut partial = String::new();
    if material.partial {
        partial.push_str(
            "\n- Only part of the transcript was read for this question. Do not claim the recording never mentions something; say it was not found in what was read.",
        );
    }
    let system = format!(
        "You answer questions about one recording, using the transcript material below.\n\
         - Each transcript line starts with its source marker, such as [src_12], then the time it was said and the speaker when known.\n\
         - The transcript is the record of what was said. Anything you add from general knowledge must be marked as your own explanation.\n\
         - Answer in the language of the question. Use short paragraphs or lists; use Markdown only when it helps.\n\
         - Support every statement taken from the recording with the marker of the exact line it comes from, placed right after that statement, such as [src_12]. Cite the line that actually says it, not a nearby one. Use one marker per bracket, and at most three markers for one statement.\n\
         - Cite only markers that appear in the material. Never write a time in place of a marker; the marker is what lets the reader jump to the moment.\n\
         - If the material does not answer the question, say so instead of guessing.{partial}"
    );
    let body = match &material.notes {
        Some(notes) => format!("Notes from reading the recording:\n\n{notes}"),
        None => format!("Transcript:\n\n{}", render(&material.units)),
    };
    let mut messages = vec![
        json!({ "role": "system", "content": system }),
        json!({ "role": "user", "content": body }),
    ];
    // The newest earlier turns that fit, so a follow-up question reads like one.
    let mut kept: Vec<&(String, String)> = Vec::new();
    let mut used = 0usize;
    for pair in job.history.iter().rev() {
        let size = pair.0.chars().count() + pair.1.chars().count();
        if used + size > HISTORY_CHARS {
            break;
        }
        used += size;
        kept.push(pair);
    }
    for (question, answer) in kept.into_iter().rev() {
        messages.push(json!({ "role": "user", "content": question }));
        messages.push(json!({ "role": "assistant", "content": answer }));
    }
    messages.push(json!({ "role": "user", "content": job.question }));
    Value::Array(messages)
}

/// Saves how a run ended.
async fn save(state: &AppState, job: &Job, outcome: Outcome, hub: Arc<super::hub::TurnHub>) {
    let key = &state.config.field_key;
    let turn_id = &job.turn_id;
    if outcome.stopped {
        hub.send(super::hub::HubEvent::State(TurnState::Cancelled));
        hub.send(super::hub::HubEvent::Done);
        // A stop keeps the text written so far and is final, whichever run asks.
        let _ = store::end_run(
            &state.db,
            key,
            None,
            turn_id,
            TurnState::Cancelled,
            None,
            None,
        )
        .await;
        return;
    }
    if let Some((code, message)) = outcome.failure {
        let name = if code == "CHAT_INTERRUPTED" {
            TurnState::Interrupted
        } else {
            TurnState::Failed
        };
        hub.send(super::hub::HubEvent::State(name));
        hub.send(super::hub::HubEvent::Done);
        let _ = store::end_run(
            &state.db,
            key,
            None,
            turn_id,
            name,
            Some(code),
            Some(&message),
        )
        .await;
        return;
    }
    // The answer is checked against the units of this revision, so only real lines are cited.
    let citations = verify(&outcome.answer, &job.units);
    hub.send(super::hub::HubEvent::Citations(citations.clone()));
    hub.send(super::hub::HubEvent::Done);
    let saved = store::finish_unfenced(
        &state.db,
        key,
        turn_id,
        job.generation,
        job.attempt,
        &job.revision.hash,
        &outcome.answer,
        &Stored {
            citations,
            partial: outcome.partial,
        },
    )
    .await;
    if !matches!(saved, Ok(true)) {
        let _ = store::end_run(
            &state.db,
            key,
            None,
            turn_id,
            TurnState::Interrupted,
            Some("CHAT_INTERRUPTED"),
            Some("This answer was replaced before it finished."),
        )
        .await;
    }
}

/// A rough token count. A character of a script written without spaces counts as a token and other
/// text as about four characters per token, so the estimate over-counts rather than under-counts.
fn estimate_tokens(messages: &Value) -> usize {
    tokens_of(&messages.to_string()) + 16
}

/// Tokens a text is likely to cost, counted high: a token for each CJK character and one for
/// every four others.
fn tokens_of(text: &str) -> usize {
    let wide = text.chars().filter(|c| *c as u32 >= 0x2e80).count();
    let narrow = text.chars().count() - wide;
    wide + narrow.div_ceil(4).max(1)
}

/// The effort a choice resolves to on a model, and whether the model's levels are known.
pub fn resolve_effort(
    choice: EffortChoice,
    provider_name: &str,
    model: &str,
) -> (EffortDecision, bool) {
    let support = support_for(provider_name, model);
    let known = !matches!(support, super::capabilities::EffortSupport::Unknown);
    (resolve(choice, &support), known)
}

/// True when a question asks about the recording as a whole rather than one passage.
///
/// This decides how a long recording is read; a transcript that fits the budget is sent whole
/// either way, so the wording never limits a short recording.
pub fn asks_about_whole(question: &str) -> bool {
    const PHRASES: &[&str] = &[
        "all ",
        "every ",
        "overall",
        "whole recording",
        "entire",
        "summar",
        "全部",
        "所有",
        "整体",
        "总结",
        "整个",
        "すべて",
        "全体",
        "전체",
        "모든",
    ];
    let lower = question.to_lowercase();
    PHRASES.iter().any(|phrase| lower.contains(phrase))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_whole_recording_question_is_recognised() {
        for question in [
            "What were all the decisions?",
            "Summarise this recording",
            "Give me every action item",
            "这条录音的全部决议是什么",
            "全体の決定は",
        ] {
            assert!(asks_about_whole(question), "{question}");
        }
        for question in [
            "When is the launch?",
            "Who mentioned the budget?",
            "预算多少",
        ] {
            assert!(!asks_about_whole(question), "{question}");
        }
    }

    #[test]
    fn tokens_are_over_counted_rather_than_under_counted() {
        let messages = json!([{ "role": "user", "content": "hello there world" }]);
        assert!(estimate_tokens(&messages) >= 3);
        let chinese = json!([{ "role": "user", "content": "你好世界你好世界" }]);
        assert!(estimate_tokens(&chinese) >= 8);
    }

    #[test]
    fn a_turn_that_needs_too_many_calls_is_refused() {
        let mut budget = Budget::new();
        for _ in 0..MAX_CALLS {
            assert!(budget.reserve(10, 10).is_ok());
        }
        assert!(
            budget.reserve(10, 10).is_err(),
            "the call budget must be bounded"
        );
    }

    #[test]
    fn a_turn_that_reserves_too_many_tokens_is_refused() {
        let mut budget = Budget::new();
        assert!(budget.reserve(MAX_INPUT_TOKENS + 1, 1).is_err());
    }
}
