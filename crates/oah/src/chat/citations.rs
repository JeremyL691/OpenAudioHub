//! Checking the source ids an answer cites (spec/recording-chat.md "Citations").
//!
//! The model may cite only the units it was given, by the id this server assigned. A cited id is
//! mapped back here to the rows the recording detail shows, so a time comes from the transcript
//! and never from the model's own words. A time written in the reply is text; only a known id can
//! become a jump target.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::context::{Place, Unit};

/// A cited unit, ready to show.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Citation {
    pub source_id: String,
    pub quote: String,
    #[serde(default)]
    pub speaker: Option<String>,
    pub start_ms: Option<i64>,
    pub end_ms: Option<i64>,
    /// True when the transcript's times were corrected, so the time is a rough place to start.
    pub approximate: bool,
    /// The timeline rows the unit covers, by their index in the transcript's timeline.
    #[serde(default)]
    pub segment_start: Option<i64>,
    #[serde(default)]
    pub segment_end: Option<i64>,
    /// The plain-text line the unit is on, and the part of it, in UTF-16 code units.
    #[serde(default)]
    pub line: Option<i64>,
    #[serde(default)]
    pub line_start: Option<i64>,
    #[serde(default)]
    pub line_end: Option<i64>,
}

impl Citation {
    /// The citation of one unit.
    pub fn of(unit: &Unit) -> Self {
        let (segment_start, segment_end, line, line_start, line_end) = match unit.place {
            Place::Segments { first, last } => {
                (Some(first as i64), Some(last as i64), None, None, None)
            }
            Place::Line { index, start, end } => (
                None,
                None,
                Some(index as i64),
                Some(start as i64),
                Some(end as i64),
            ),
        };
        Self {
            source_id: unit.id(),
            quote: quote_of(&unit.text),
            speaker: unit.speaker.clone(),
            start_ms: unit.start_ms,
            end_ms: unit.end_ms,
            approximate: unit.approximate && unit.start_ms.is_some(),
            segment_start,
            segment_end,
            line,
            line_start,
            line_end,
        }
    }

    /// The same citation with nothing that points into a transcript: its text only.
    pub fn text_only(&self) -> Self {
        Self {
            start_ms: None,
            end_ms: None,
            approximate: false,
            segment_start: None,
            segment_end: None,
            line: None,
            line_start: None,
            line_end: None,
            ..self.clone()
        }
    }
}

/// Reads `[src_1]` style markers and keeps the ones that name a unit this turn was given.
///
/// A marker that is incomplete, has spaces, or names an unknown source is not a citation. The
/// order is the order the answer cited them in, so the list reads the way the answer does.
pub fn verify(answer: &str, units: &[Unit]) -> Vec<Citation> {
    let mut out: Vec<Citation> = Vec::new();
    for id in markers(answer) {
        let Some(unit) = unit_by_id(units, &id) else {
            continue;
        };
        if out.iter().any(|c| c.source_id == id) {
            continue;
        }
        out.push(Citation::of(unit));
    }
    out
}

/// The unit an id names. Ids follow ordinals, so this is a direct lookup.
pub fn unit_by_id<'a>(units: &'a [Unit], id: &str) -> Option<&'a Unit> {
    let ordinal: usize = id.strip_prefix("src_")?.parse().ok()?;
    let unit = units.get(ordinal.checked_sub(1)?)?;
    (unit.id() == id).then_some(unit)
}

/// The source ids an answer cites, in order and without repeats.
///
/// Models write one id per bracket, several ids in one bracket separated by commas, or full-width
/// brackets; all of them are read.
fn markers(answer: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut rest = answer;
    while let Some(open) = rest.find(['[', '【']) {
        let after = &rest[open + rest[open..].chars().next().map_or(1, char::len_utf8)..];
        let Some(close) = after.find([']', '】']) else {
            break;
        };
        let inner = &after[..close];
        let parts: Vec<&str> = inner.split([',', '，', '、']).map(str::trim).collect();
        if parts.iter().all(|part| is_source_id(part)) {
            for part in parts {
                if !out.iter().any(|id| id == part) {
                    out.push(part.to_owned());
                }
            }
        }
        rest = &after[close..];
    }
    out
}

/// True for the ids this server hands out: `src_` and digits, nothing else.
fn is_source_id(text: &str) -> bool {
    let Some(rest) = text.strip_prefix("src_") else {
        return false;
    };
    !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit())
}

/// The quoted text a citation shows. Whitespace is collapsed so a unit split over lines reads as
/// one sentence, and a very long unit keeps a readable opening.
fn quote_of(text: &str) -> String {
    const MAX_CHARS: usize = 240;
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= MAX_CHARS {
        return collapsed;
    }
    let mut out: String = collapsed.chars().take(MAX_CHARS).collect();
    out.push('…');
    out
}

/// What a turn stores besides its text: the citations, and whether only part of the transcript
/// was read for it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Stored {
    pub citations: Vec<Citation>,
    #[serde(default)]
    pub partial: bool,
}

impl Stored {
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

/// Reads saved citations back out of storage. A list on its own is what turns saved before the
/// envelope held anything else look like.
pub fn from_stored(value: &Value) -> Stored {
    if value.is_array() {
        return Stored {
            citations: serde_json::from_value(value.clone()).unwrap_or_default(),
            partial: false,
        };
    }
    serde_json::from_value(value.clone()).unwrap_or_default()
}
