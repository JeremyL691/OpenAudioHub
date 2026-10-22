//! In-process broadcast hub for real-time token streaming (spec/recording-chat.md).
//!
//! When upstream yields tokens, they are broadcast directly to connected clients without
//! waiting for a database write. The database remains the storage of record through periodic
//! checkpoints and final write-back.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use tokio::sync::broadcast;

use super::citations::Citation;
use super::store::TurnState;

/// Events broadcast during a running turn.
#[derive(Debug, Clone)]
pub enum HubEvent {
    Thinking,
    Delta(String),
    State(TurnState),
    Citations(Vec<Citation>),
    Done,
}

pub struct TurnHub {
    pub turn_id: String,
    tx: broadcast::Sender<HubEvent>,
    answer: Mutex<String>,
}

impl TurnHub {
    pub fn new(turn_id: &str) -> Self {
        let (tx, _) = broadcast::channel(512);
        Self {
            turn_id: turn_id.to_owned(),
            tx,
            answer: Mutex::new(String::new()),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<HubEvent> {
        self.tx.subscribe()
    }

    pub fn send(&self, event: HubEvent) {
        if let HubEvent::Delta(ref text) = event
            && let Ok(mut answer) = self.answer.lock()
        {
            answer.push_str(text);
        }
        let _ = self.tx.send(event);
    }

    pub fn current_answer(&self) -> String {
        self.answer.lock().map(|a| a.clone()).unwrap_or_default()
    }
}

static HUBS: OnceLock<Mutex<HashMap<String, Arc<TurnHub>>>> = OnceLock::new();

fn registry() -> &'static Mutex<HashMap<String, Arc<TurnHub>>> {
    HUBS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Registers an active turn hub for real-time streaming.
pub fn register(turn_id: &str) -> Arc<TurnHub> {
    let mut hubs = registry().lock().expect("hub registry lock");
    let hub = Arc::new(TurnHub::new(turn_id));
    hubs.insert(turn_id.to_owned(), hub.clone());
    hub
}

/// Looks up an active turn hub if one is currently streaming.
pub fn get(turn_id: &str) -> Option<Arc<TurnHub>> {
    let hubs = registry().lock().ok()?;
    hubs.get(turn_id).cloned()
}

/// Unregisters a completed or cancelled turn hub.
pub fn unregister(turn_id: &str) {
    if let Ok(mut hubs) = registry().lock() {
        hubs.remove(turn_id);
    }
}
