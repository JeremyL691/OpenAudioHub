//! The identity of the transcript a turn answers from (spec/recording-chat.md "Concepts").
//!
//! Every turn records the revision it was answered from, and a saved result is refused once that
//! revision is no longer current. The revision therefore covers everything that can change while
//! the words stay the same: the timeline, where the timeline came from, and the way this server
//! splits the text into pieces. The same sentence with a corrected timeline is a new revision,
//! because an answer that pointed at the old times would otherwise still look current.

use serde_json::Value;
use sha2::{Digest, Sha256};

/// Bumped when the rules that turn a transcript into citable units change, so an answer that
/// cites units of an older rule is never read against the new ones.
pub const CHUNKER_VERSION: i64 = 2;

/// One stored transcript, as the revision and the pieces need it.
pub struct Transcript {
    pub id: String,
    pub source: String,
    pub text: String,
    pub timeline: Option<Value>,
    pub timeline_source: Option<String>,
    pub created_at: i64,
}

/// What the transcript's timings are worth.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Timing {
    /// The provider's own times.
    Native,
    /// Some times were corrected to fit the audio.
    Normalized,
    /// No timeline, an unreadable one, or one this server cannot map to the text.
    None,
}

impl Timing {
    /// Reads the stored timeline source. Anything unknown is treated as no timing at all rather
    /// than as a time the interface may jump to.
    pub fn of(timeline_source: Option<&str>) -> Self {
        match timeline_source {
            Some("native") => Self::Native,
            Some("normalized") => Self::Normalized,
            _ => Self::None,
        }
    }

    /// True when a citation may offer a time.
    pub fn has_time(self) -> bool {
        matches!(self, Self::Native | Self::Normalized)
    }

    pub fn as_str(self) -> Option<&'static str> {
        match self {
            Self::Native => Some("native"),
            Self::Normalized => Some("normalized"),
            Self::None => None,
        }
    }
}

/// The identity of one version of one transcript.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Revision {
    /// Stable for the same transcript version; stored on every turn.
    pub hash: String,
    pub transcript_id: String,
    pub source: String,
    pub timing: Timing,
}

impl Revision {
    /// `user_id` is part of the hash so the same words transcribed for two accounts never share an
    /// identity, which keeps a saved piece from ever being read across accounts.
    pub fn of(user_id: &str, recording_id: &str, transcript: &Transcript) -> Self {
        let timing = Timing::of(transcript.timeline_source.as_deref());
        let mut hasher = Sha256::new();
        // Length-prefixed fields: without them, moving a character between fields could keep the
        // same bytes and therefore the same revision.
        let mut field = |bytes: &[u8]| {
            hasher.update((bytes.len() as u64).to_le_bytes());
            hasher.update(bytes);
        };
        field(user_id.as_bytes());
        field(recording_id.as_bytes());
        field(transcript.id.as_bytes());
        field(transcript.source.as_bytes());
        field(&transcript.created_at.to_le_bytes());
        field(transcript.text.as_bytes());
        let timeline = transcript
            .timeline
            .as_ref()
            .map(|value| value.to_string())
            .unwrap_or_default();
        field(timeline.as_bytes());
        field(
            transcript
                .timeline_source
                .as_deref()
                .unwrap_or("")
                .as_bytes(),
        );
        field(&CHUNKER_VERSION.to_le_bytes());
        Self {
            hash: format!("rv_{}", hex::encode(hasher.finalize())),
            transcript_id: transcript.id.clone(),
            source: transcript.source.clone(),
            timing,
        }
    }
}
