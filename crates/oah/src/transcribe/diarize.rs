//! Speaker turns for diarized output (spec/transcription.md, "Speaker labels").

use std::collections::HashMap;

use super::Segment;

/// `mm:ss`, or `hh:mm:ss` from one hour on.
pub fn stamp(seconds: f64) -> String {
    let total = seconds.max(0.0) as u64;
    let (h, m, s) = (total / 3600, total % 3600 / 60, total % 60);
    if h > 0 {
        format!("{h:02}:{m:02}:{s:02}")
    } else {
        format!("{m:02}:{s:02}")
    }
}

/// Numbers speakers in order of first appearance across a whole run.
#[derive(Default)]
pub struct Speakers(HashMap<String, usize>);

impl Speakers {
    pub fn label(&mut self, raw: &str) -> String {
        let next = self.0.len() + 1;
        let number = *self.0.entry(raw.to_owned()).or_insert(next);
        format!("Speaker {number}")
    }
}

/// Merges one part's segments into turns, one per run of the same speaker.
/// Times are shifted by `offset` seconds and each turn's speaker holds its label.
pub fn turns(segments: &[Segment], offset: f64, speakers: &mut Speakers) -> Vec<Segment> {
    let mut out: Vec<Segment> = Vec::new();
    for seg in segments {
        let text = seg.text.trim();
        if text.is_empty() {
            continue;
        }
        let label = speakers.label(seg.speaker.as_deref().unwrap_or_default());
        match out.last_mut() {
            Some(last) if last.speaker.as_deref() == Some(label.as_str()) => {
                last.text.push(' ');
                last.text.push_str(text);
                last.end = seg.end + offset;
            }
            _ => out.push(Segment {
                start: seg.start + offset,
                end: seg.end + offset,
                text: text.to_owned(),
                speaker: Some(label),
            }),
        }
    }
    out
}

/// `[mm:ss] Speaker N` with the text on the next line, turns separated by a blank line.
/// From the second part on (`part` is 1-based), each turn label gets `· Part N`.
pub fn render(turns: &[Segment], part: usize) -> String {
    let suffix = if part > 1 {
        format!(" · Part {part}")
    } else {
        String::new()
    };
    turns
        .iter()
        .map(|t| {
            format!(
                "[{}] {}{suffix}\n{}",
                stamp(t.start),
                t.speaker.as_deref().unwrap_or_default(),
                t.text
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(start: f64, end: f64, text: &str, speaker: &str) -> Segment {
        Segment {
            start,
            end,
            text: text.into(),
            speaker: Some(speaker.into()),
        }
    }

    #[test]
    fn stamps_switch_to_hours() {
        assert_eq!(stamp(0.0), "00:00");
        assert_eq!(stamp(1.5), "00:01");
        assert_eq!(stamp(754.9), "12:34");
        assert_eq!(stamp(3725.0), "01:02:05");
    }

    #[test]
    fn speakers_number_by_first_appearance() {
        let mut s = Speakers::default();
        assert_eq!(s.label("B"), "Speaker 1");
        assert_eq!(s.label("A"), "Speaker 2");
        assert_eq!(s.label("B"), "Speaker 1");
    }

    #[test]
    fn consecutive_same_speaker_merges_and_offsets_apply() {
        let segments = [
            seg(0.0, 1.0, "Hello", "A"),
            seg(1.0, 2.0, " there ", "A"),
            seg(2.0, 3.0, "Bye", "B"),
            seg(3.0, 3.5, "  ", "B"),
        ];
        let mut speakers = Speakers::default();
        let turns = turns(&segments, 10.0, &mut speakers);
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].text, "Hello there");
        assert_eq!(turns[0].end, 12.0);
        assert_eq!(turns[0].start, 10.0);
        assert_eq!(turns[1].speaker.as_deref(), Some("Speaker 2"));
    }

    #[test]
    fn render_labels_parts_after_the_first() {
        let turns = vec![
            seg(0.0, 1.0, "One", "Speaker 1"),
            seg(1.5, 2.0, "Two", "Speaker 2"),
        ];
        assert_eq!(
            render(&turns, 1),
            "[00:00] Speaker 1\nOne\n\n[00:01] Speaker 2\nTwo"
        );
        assert!(render(&turns, 2).starts_with("[00:00] Speaker 1 · Part 2\nOne"));
    }
}
