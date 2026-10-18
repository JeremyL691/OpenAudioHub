//! Merging chunk results into one transcript with absolute timestamps (spec section 11).

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::transcribe::{Segment, Transcript};

const SAMPLE_RATE: f64 = 16_000.0;
/// Overshoot past the chunk end that is still accepted (50 ms).
const GUARD_SECONDS: f64 = 0.050;

/// A chunk's stored provider answer.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Stored {
    pub text: String,
    pub language: Option<String>,
    pub segments: Vec<Segment>,
}

pub struct ChunkIn<'a> {
    pub index: usize,
    pub start_sample: u64,
    pub end_sample: u64,
    pub result: &'a Stored,
}

pub struct Merged {
    pub transcript: Transcript,
    /// Timeline items, empty when the timestamps could not be kept.
    pub timeline: Vec<Value>,
    pub timestamp_source: Option<&'static str>,
    pub needs_alignment: bool,
}

/// Item of the merged timeline, in milliseconds.
struct Item {
    start_ms: i64,
    end_ms: i64,
    text: String,
    speaker: Option<String>,
    chunk_index: usize,
    correction: Option<(i64, i64)>,
}

/// Round half to even, for millisecond values.
fn ms_round(ms: f64) -> i64 {
    ms.round_ties_even() as i64
}

/// Timeline of one chunk, or `None` when its timestamps are invalid.
fn chunk_items(chunk: &ChunkIn) -> Option<Vec<Item>> {
    let segments: Vec<&Segment> = chunk
        .result
        .segments
        .iter()
        .filter(|s| !s.text.trim().is_empty())
        .collect();
    if segments.is_empty() {
        return (chunk.result.text.trim().is_empty()).then(Vec::new);
    }
    let chunk_start = chunk.start_sample as f64 / SAMPLE_RATE;
    let chunk_len = (chunk.end_sample - chunk.start_sample) as f64 / SAMPLE_RATE;
    let chunk_end_ms = ms_round(chunk.end_sample as f64 / SAMPLE_RATE * 1000.0);
    let mut items = Vec::with_capacity(segments.len());
    let mut previous = 0.0f64;
    for seg in segments {
        if !seg.start.is_finite()
            || !seg.end.is_finite()
            || seg.start < 0.0
            || seg.end <= seg.start
            || seg.start < previous
        {
            return None;
        }
        previous = seg.start;
        let over = seg.end - chunk_len;
        if over > GUARD_SECONDS + 1e-9 {
            return None;
        }
        let raw_end_ms = ms_round((chunk_start + seg.end) * 1000.0);
        let start_ms = ms_round((chunk_start + seg.start) * 1000.0);
        let (end_ms, correction) = if over > 0.0 {
            (chunk_end_ms, Some((raw_end_ms, chunk_end_ms)))
        } else {
            (raw_end_ms, None)
        };
        if end_ms <= start_ms {
            return None;
        }
        items.push(Item {
            start_ms,
            end_ms,
            text: seg.text.clone(),
            speaker: seg.speaker.clone(),
            chunk_index: chunk.index,
            correction,
        });
    }
    Some(items)
}

pub fn merge(chunks: &[ChunkIn]) -> Merged {
    let text = chunks
        .iter()
        .map(|c| c.result.text.trim())
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    let language = match chunks.first().and_then(|c| c.result.language.clone()) {
        Some(first)
            if chunks
                .iter()
                .all(|c| c.result.language.as_deref() == Some(first.as_str())) =>
        {
            Some(first)
        }
        _ => None,
    };

    let mut items: Vec<Item> = Vec::new();
    let mut needs_alignment = false;
    for chunk in chunks {
        match chunk_items(chunk) {
            Some(mut found) => items.append(&mut found),
            None => needs_alignment = true,
        }
    }
    if needs_alignment {
        return Merged {
            transcript: Transcript {
                text,
                language,
                segments: Vec::new(),
            },
            timeline: Vec::new(),
            timestamp_source: None,
            needs_alignment: true,
        };
    }
    items.sort_by_key(|i| (i.start_ms, i.end_ms));

    let normalized = items.iter().any(|i| i.correction.is_some());
    let timestamp_source = if items.is_empty() {
        None
    } else if normalized {
        Some("normalized")
    } else {
        Some("native")
    };
    let timeline = items
        .iter()
        .map(|i| {
            let source = if i.correction.is_some() {
                "normalized"
            } else {
                "native"
            };
            let mut v = json!({
                "start_ms": i.start_ms,
                "end_ms": i.end_ms,
                "text": i.text,
                "timestamp_source": source,
                "chunk_index": i.chunk_index,
            });
            if let Some(speaker) = &i.speaker {
                v["speaker_id"] = json!(speaker);
            }
            if let Some((original, normalized_end)) = i.correction {
                v["timestamp_correction"] = json!({
                    "reason": "chunk_end_guard",
                    "original_end_ms": original,
                    "normalized_end_ms": normalized_end,
                    "chunk_index": i.chunk_index,
                });
            }
            v
        })
        .collect();
    let segments = items
        .into_iter()
        .map(|i| Segment {
            start: i.start_ms as f64 / 1000.0,
            end: i.end_ms as f64 / 1000.0,
            text: i.text,
            speaker: i.speaker,
        })
        .collect();
    Merged {
        transcript: Transcript {
            text,
            language,
            segments,
        },
        timeline,
        timestamp_source,
        needs_alignment: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(start: f64, end: f64, text: &str) -> Segment {
        Segment {
            start,
            end,
            text: text.into(),
            speaker: None,
        }
    }

    fn stored(text: &str, language: Option<&str>, segments: Vec<Segment>) -> Stored {
        Stored {
            text: text.into(),
            language: language.map(Into::into),
            segments,
        }
    }

    #[test]
    fn ties_round_to_even() {
        assert_eq!(ms_round(0.5), 0);
        assert_eq!(ms_round(1.5), 2);
        assert_eq!(ms_round(2.5), 2);
    }

    #[test]
    fn two_chunks_get_absolute_times() {
        let a = stored("one", Some("en"), vec![seg(1.0, 2.0, "one")]);
        let b = stored("two", Some("en"), vec![seg(0.5, 1.0, "two")]);
        let m = merge(&[
            ChunkIn {
                index: 0,
                start_sample: 0,
                end_sample: 160_000,
                result: &a,
            },
            ChunkIn {
                index: 1,
                start_sample: 160_000,
                end_sample: 240_000,
                result: &b,
            },
        ]);
        assert!(!m.needs_alignment);
        assert_eq!(m.transcript.text, "one\n\ntwo");
        assert_eq!(m.transcript.language.as_deref(), Some("en"));
        assert_eq!(m.timestamp_source, Some("native"));
        assert_eq!(m.timeline[1]["start_ms"], 10_500);
        assert_eq!(m.timeline[1]["end_ms"], 11_000);
    }

    #[test]
    fn small_overshoot_is_normalized_and_large_one_needs_alignment() {
        let ok = stored("x", None, vec![seg(0.0, 10.04, "x")]);
        let m = merge(&[ChunkIn {
            index: 0,
            start_sample: 0,
            end_sample: 160_000,
            result: &ok,
        }]);
        assert!(!m.needs_alignment);
        assert_eq!(m.timeline[0]["end_ms"], 10_000);
        assert_eq!(
            m.timeline[0]["timestamp_correction"]["original_end_ms"],
            10_040
        );
        assert_eq!(m.timestamp_source, Some("normalized"));

        let bad = stored("x", None, vec![seg(0.0, 10.08, "x")]);
        let m = merge(&[ChunkIn {
            index: 0,
            start_sample: 0,
            end_sample: 160_000,
            result: &bad,
        }]);
        assert!(m.needs_alignment);
        assert!(m.timeline.is_empty());
    }

    #[test]
    fn text_without_timings_needs_alignment_and_disagreeing_languages_drop() {
        let a = stored("hello", Some("en"), vec![]);
        let b = stored("hallo", Some("de"), vec![seg(0.0, 1.0, "hallo")]);
        let m = merge(&[
            ChunkIn {
                index: 0,
                start_sample: 0,
                end_sample: 16_000,
                result: &b,
            },
            ChunkIn {
                index: 1,
                start_sample: 16_000,
                end_sample: 32_000,
                result: &a,
            },
        ]);
        assert!(m.needs_alignment);
        assert_eq!(m.transcript.language, None);
    }
}
