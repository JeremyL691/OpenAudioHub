//! The parts of a transcript a question reads and an answer cites (spec/recording-chat.md
//! "What the model receives", "Citations").
//!
//! The unit an answer cites is the row the recording detail shows. A transcript with a usable
//! timeline is cited by its timeline segments, so a citation names the exact rows and the moment
//! the provider gave them. A transcript without one is cited by its lines, and a very long line by
//! the sentences in it. Nothing is matched by similarity and no time is estimated: a unit carries
//! the time of the segments it is made of, or none.
//!
//! Units are grouped into windows only to search a long transcript. Nothing here talks to a
//! provider or to the database.

use serde_json::Value;

use super::revision::Timing;

/// The longest search window, in Unicode characters.
pub const TARGET_CHARS: usize = 1000;
/// A line longer than this, in Unicode characters, is cited by the sentences in it.
pub const LINE_UNIT_CHARS: usize = 400;
/// Short timeline segments of one speaker are cited together until the unit reaches this many
/// characters. A segment that is already this long stands alone.
const MERGE_BELOW_CHARS: usize = 60;
/// A merged unit never grows past this many characters or this many milliseconds.
const MERGE_MAX_CHARS: usize = 200;
const MERGE_MAX_MS: i64 = 20_000;

/// One citable part of a transcript.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unit {
    /// Position in the transcript, from 0. The id an answer cites is `src_{ordinal + 1}`.
    pub ordinal: i64,
    pub text: String,
    pub speaker: Option<String>,
    pub start_ms: Option<i64>,
    pub end_ms: Option<i64>,
    /// True when the transcript's times were corrected to fit the audio.
    pub approximate: bool,
    pub place: Place,
}

/// Where a unit sits in what the recording detail shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Place {
    /// Rows `first..=last` of the transcript's timeline, by their index in the stored array.
    Segments { first: usize, last: usize },
    /// One line of the plain transcript, counted as the detail counts them: split on line ends,
    /// trimmed, blank lines skipped. `start..end` is the part of the trimmed line, in UTF-16 code
    /// units so a browser can mark it without converting.
    Line {
        index: usize,
        start: usize,
        end: usize,
    },
}

impl Unit {
    /// The id an answer cites this unit by.
    pub fn id(&self) -> String {
        format!("src_{}", self.ordinal + 1)
    }

    /// The unit as the model reads it: its id, the moment it was said, the speaker and the words.
    pub fn render(&self) -> String {
        let mut out = format!("[{}]", self.id());
        if let Some(start) = self.start_ms {
            out.push(' ');
            out.push_str(&clock(start));
        }
        if let Some(speaker) = &self.speaker {
            out.push(' ');
            out.push_str(&speaker_name(speaker));
            out.push(':');
        }
        out.push(' ');
        out.push_str(&self.text);
        out
    }
}

/// A speaker id as the recording detail shows it: `SPEAKER_00` reads as `Speaker 1`, so the
/// model names speakers the way the reader sees them.
fn speaker_name(id: &str) -> String {
    id.strip_prefix("SPEAKER_")
        .and_then(|digits| digits.parse::<u32>().ok())
        .map_or_else(|| id.to_owned(), |n| format!("Speaker {}", n + 1))
}

/// The units of one transcript, in order.
///
/// The timeline is used whenever it has rows with a usable time and its source is one the app
/// trusts, which is when the recording detail shows the timed view. Otherwise the text is used.
pub fn units(text: &str, timeline: Option<&Value>, timing: Timing) -> Vec<Unit> {
    if timing.has_time()
        && let Some(units) = timeline
            .and_then(Value::as_array)
            .map(|rows| segment_units(rows, timing))
            .filter(|units| !units.is_empty())
    {
        return units;
    }
    line_units(text)
}

/// Units from timeline rows. A row without text or without a time is skipped, and short rows of
/// one speaker are joined so a citation is not a single word.
fn segment_units(rows: &[Value], timing: Timing) -> Vec<Unit> {
    let approximate = matches!(timing, Timing::Normalized);
    let mut out: Vec<Unit> = Vec::new();
    for (index, row) in rows.iter().enumerate() {
        let text = row["text"].as_str().map(str::trim).unwrap_or_default();
        let (Some(start), Some(end)) = (row["start_ms"].as_i64(), row["end_ms"].as_i64()) else {
            continue;
        };
        if text.is_empty() {
            continue;
        }
        let speaker = row["speaker_id"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        if let Some(last) = out.last_mut()
            && let Place::Segments {
                first,
                last: last_index,
            } = last.place
            && last_index + 1 == index
            && last.speaker == speaker
            && last.text.chars().count() < MERGE_BELOW_CHARS
            && last.text.chars().count() + 1 + text.chars().count() <= MERGE_MAX_CHARS
            && end - last.start_ms.unwrap_or(start) <= MERGE_MAX_MS
        {
            last.text = join_words(&last.text, text);
            last.end_ms = Some(end.max(last.end_ms.unwrap_or(end)));
            last.place = Place::Segments { first, last: index };
            continue;
        }
        out.push(Unit {
            ordinal: out.len() as i64,
            text: text.to_owned(),
            speaker,
            start_ms: Some(start),
            end_ms: Some(end.max(start)),
            approximate,
            place: Place::Segments {
                first: index,
                last: index,
            },
        });
    }
    out
}

/// Joins two runs of words. Scripts written without spaces are joined without one.
fn join_words(left: &str, right: &str) -> String {
    let unspaced = |c: Option<char>| c.is_some_and(is_unspaced_char);
    if unspaced(left.chars().last()) && unspaced(right.chars().next()) {
        format!("{left}{right}")
    } else {
        format!("{left} {right}")
    }
}

/// Units from the plain text: one per line, and one per group of sentences in a long line.
fn line_units(text: &str) -> Vec<Unit> {
    let mut out = Vec::new();
    let lines = text.split('\n').map(str::trim).filter(|l| !l.is_empty());
    for (index, line) in lines.enumerate() {
        for (start, end) in line_parts(line) {
            let part: String = slice_utf16(line, start, end).trim().to_owned();
            if part.is_empty() {
                continue;
            }
            out.push(Unit {
                ordinal: out.len() as i64,
                text: part,
                speaker: None,
                start_ms: None,
                end_ms: None,
                approximate: false,
                place: Place::Line { index, start, end },
            });
        }
    }
    out
}

/// The parts a line is cited by, as UTF-16 ranges. A short line is one part; a long one is cut
/// after sentence ends into parts of at most `LINE_UNIT_CHARS` characters, and a sentence longer
/// than that is cut where the limit falls.
fn line_parts(line: &str) -> Vec<(usize, usize)> {
    let chars: Vec<char> = line.chars().collect();
    if chars.len() <= LINE_UNIT_CHARS {
        return vec![(0, line.encode_utf16().count())];
    }
    // Sentence ends, as character offsets just after the mark.
    let mut sentences: Vec<usize> = Vec::new();
    for (i, c) in chars.iter().enumerate() {
        if matches!(*c, '.' | '!' | '?' | '。' | '！' | '？' | '；' | ';') {
            sentences.push(i + 1);
        }
    }
    let mut parts_chars: Vec<(usize, usize)> = Vec::new();
    let mut start = 0usize;
    while start < chars.len() {
        let limit = (start + LINE_UNIT_CHARS).min(chars.len());
        let end = if limit == chars.len() {
            limit
        } else {
            sentences
                .iter()
                .copied()
                .filter(|&at| at > start && at <= limit)
                .max()
                .unwrap_or(limit)
        };
        parts_chars.push((start, end));
        start = end;
    }
    // Character offsets to UTF-16 offsets.
    let mut utf16_at = Vec::with_capacity(chars.len() + 1);
    let mut acc = 0usize;
    for c in &chars {
        utf16_at.push(acc);
        acc += c.len_utf16();
    }
    utf16_at.push(acc);
    parts_chars
        .into_iter()
        .map(|(s, e)| (utf16_at[s], utf16_at[e]))
        .collect()
}

/// The part of `text` between two UTF-16 offsets.
fn slice_utf16(text: &str, start: usize, end: usize) -> String {
    let mut out = String::new();
    let mut at = 0usize;
    for c in text.chars() {
        if at >= end {
            break;
        }
        if at >= start {
            out.push(c);
        }
        at += c.len_utf16();
    }
    out
}

/// A time as the transcript view shows it: `m:ss`, or `h:mm:ss` from one hour on.
pub fn clock(ms: i64) -> String {
    let total = ms.max(0) / 1000;
    let (h, m, s) = (total / 3600, (total % 3600) / 60, total % 60);
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m}:{s:02}")
    }
}

/// A run of consecutive units searched as one, for a transcript too long to send whole.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Window {
    pub ordinal: i64,
    /// The units in this window, as a range of unit ordinals.
    pub first: usize,
    pub last: usize,
    pub body: String,
}

/// Groups units into windows of at most `TARGET_CHARS` characters. Windows do not overlap: a unit
/// is whole, so nothing is cut on a boundary.
pub fn windows(units: &[Unit]) -> Vec<Window> {
    let mut out: Vec<Window> = Vec::new();
    let mut first = 0usize;
    let mut size = 0usize;
    let mut body = String::new();
    for (i, unit) in units.iter().enumerate() {
        let chars = unit.text.chars().count();
        if size + chars > TARGET_CHARS && !body.is_empty() {
            out.push(Window {
                ordinal: out.len() as i64,
                first,
                last: i - 1,
                body: std::mem::take(&mut body),
            });
            first = i;
            size = 0;
        }
        if !body.is_empty() {
            body.push('\n');
        }
        body.push_str(&unit.text);
        size += chars;
    }
    if !body.is_empty() {
        out.push(Window {
            ordinal: out.len() as i64,
            first,
            last: units.len() - 1,
            body,
        });
    }
    out
}

/// The number of windows a search keeps before neighbours are added.
pub const TOP_PASSAGES: usize = 12;

/// One search hit.
#[derive(Debug, Clone)]
pub struct Hit {
    pub window: Window,
    pub score: f64,
}

/// Finds the windows that best answer `question`, best first.
///
/// The transcript and the question are compared on words and on character bigrams, so a Chinese
/// transcript is searchable without a word splitter, and a name shared with a question in another
/// language still matches. A question whose words appear nowhere finds nothing, which the caller
/// reports as "not found in this search" rather than as "not in the recording".
pub fn search(question: &str, windows: &[Window], limit: usize) -> Vec<Hit> {
    let terms = terms_of(question);
    if terms.is_empty() || windows.is_empty() {
        return Vec::new();
    }
    let documents: Vec<Vec<String>> = windows.iter().map(|w| terms_of(&w.body)).collect();
    let mut document_frequency = std::collections::HashMap::<&str, usize>::new();
    for document in &documents {
        let unique: std::collections::HashSet<&str> = document.iter().map(String::as_str).collect();
        for term in unique {
            *document_frequency.entry(term).or_default() += 1;
        }
    }
    let total = documents.len() as f64;
    let average_length = documents.iter().map(Vec::len).sum::<usize>() as f64 / total;
    // A term that sits in most windows says nothing about which window to send. Dropping it is
    // what keeps a question made of common words ("what is the weather in Paris") from matching
    // everything.
    let terms: Vec<String> = terms
        .into_iter()
        .filter(|term| {
            let df = *document_frequency.get(term.as_str()).unwrap_or(&0) as f64;
            df / total <= 0.5
        })
        .collect();
    if terms.is_empty() {
        return Vec::new();
    }
    let mut hits: Vec<Hit> = windows
        .iter()
        .zip(&documents)
        .filter_map(|(window, document)| {
            let score = bm25(&terms, document, &document_frequency, total, average_length);
            (score > 0.0).then(|| Hit {
                window: window.clone(),
                score,
            })
        })
        .collect();
    // A higher score first; ties keep transcript order so a search is reproducible.
    hits.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.window.ordinal.cmp(&b.window.ordinal))
    });
    hits.truncate(limit);
    hits
}

/// Adds the windows next to a hit, so a passage cut in two is read with its continuation.
pub fn with_neighbours(hits: &[Hit], windows: &[Window], extra: usize) -> Vec<Window> {
    let mut wanted: Vec<i64> = hits.iter().map(|h| h.window.ordinal).collect();
    for hit in hits {
        for step in 1..=extra as i64 {
            for ordinal in [hit.window.ordinal - step, hit.window.ordinal + step] {
                if windows.iter().any(|w| w.ordinal == ordinal) {
                    wanted.push(ordinal);
                }
            }
        }
    }
    let mut out: Vec<Window> = windows
        .iter()
        .filter(|w| wanted.contains(&w.ordinal))
        .cloned()
        .collect();
    out.sort_by_key(|w| w.ordinal);
    out
}

/// What a question sends: either every unit or the units it needs.
#[derive(Debug, Clone)]
pub struct Selection {
    /// True when every unit was sent, so the answer may speak for the whole recording.
    pub whole: bool,
    pub units: Vec<Unit>,
}

/// The characters a set of units costs when sent, ids and times included.
pub fn rendered_chars(units: &[Unit]) -> usize {
    units.iter().map(|u| u.render().chars().count() + 1).sum()
}

/// Chooses what to send for `question` within `budget` characters.
///
/// A transcript that fits in the budget is sent whole, which is what makes a short recording
/// answered completely. A longer one sends the windows the question matches, with their
/// neighbours, in transcript order, and never more than the budget allows. When the budget is
/// tight, the best matches are kept before any neighbour.
pub fn select(question: &str, units: &[Unit], budget: usize) -> Selection {
    if rendered_chars(units) <= budget {
        return Selection {
            whole: true,
            units: units.to_vec(),
        };
    }
    let windows = windows(units);
    let hits = search(question, &windows, TOP_PASSAGES);
    let mut order: Vec<i64> = hits.iter().map(|h| h.window.ordinal).collect();
    for window in with_neighbours(&hits, &windows, 1) {
        if !order.contains(&window.ordinal) {
            order.push(window.ordinal);
        }
    }
    let mut used = 0usize;
    let mut chosen: Vec<&Window> = Vec::new();
    for ordinal in order {
        let window = &windows[ordinal as usize];
        let size = rendered_chars(&units[window.first..=window.last]);
        if used + size > budget {
            continue;
        }
        used += size;
        chosen.push(window);
    }
    chosen.sort_by_key(|w| w.ordinal);
    Selection {
        whole: false,
        units: chosen
            .into_iter()
            .flat_map(|w| units[w.first..=w.last].iter().cloned())
            .collect(),
    }
}

/// The searchable terms of a text: lowercased word runs, and the character bigrams of runs that
/// have no spaces between words, which is how Chinese and Japanese text is matched.
fn terms_of(text: &str) -> Vec<String> {
    use unicode_normalization::UnicodeNormalization;
    let folded: String = text.nfkc().collect::<String>().to_lowercase();
    let mut out = Vec::new();
    for run in split_runs(&folded) {
        if run.chars().count() > 1 && is_unspaced(&run) {
            let chars: Vec<char> = run.chars().collect();
            for pair in chars.windows(2) {
                out.push(pair.iter().collect());
            }
        } else {
            for word in run.split_whitespace() {
                let word = trim_word(word);
                if word.chars().count() > 1 && !is_stop_word(word) {
                    out.push(word.to_owned());
                }
            }
        }
    }
    out
}

/// Splits text into runs of letters, digits and the characters used inside a word.
fn split_runs(text: &str) -> Vec<String> {
    let mut runs = Vec::new();
    let mut current = String::new();
    for c in text.chars() {
        if c.is_alphanumeric() || c == '\'' || c == '-' || c == '_' {
            current.push(c);
        } else if !current.is_empty() {
            runs.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        runs.push(current);
    }
    runs
}

/// True when a run has no spaces and is written without word breaks, as Chinese is.
fn is_unspaced(run: &str) -> bool {
    run.chars().any(is_unspaced_char)
}

fn is_unspaced_char(c: char) -> bool {
    matches!(c as u32,
        0x3040..=0x30ff | 0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xf900..=0xfaff | 0xac00..=0xd7af)
}

fn trim_word(word: &str) -> &str {
    word.trim_matches(|c: char| !c.is_alphanumeric())
}

/// Words that carry no topic. A question made only of these finds nothing, which is the honest
/// answer: the recording may well mention "the", but that says nothing about where to look.
const STOP_WORDS: &[&str] = &[
    "a", "about", "after", "all", "am", "an", "and", "any", "are", "as", "at", "be", "because",
    "been", "before", "being", "both", "but", "by", "can", "could", "did", "do", "does", "doing",
    "done", "each", "for", "from", "had", "has", "have", "having", "he", "her", "here", "him",
    "his", "how", "i", "if", "in", "into", "is", "it", "its", "just", "me", "more", "most", "my",
    "no", "not", "now", "of", "on", "once", "only", "or", "other", "our", "out", "over", "own",
    "same", "she", "should", "so", "some", "such", "than", "that", "the", "their", "them", "then",
    "there", "these", "they", "this", "those", "through", "to", "too", "under", "until", "up",
    "very", "was", "we", "were", "what", "when", "where", "which", "while", "who", "whom", "why",
    "will", "with", "would", "you", "your",
];

fn is_stop_word(word: &str) -> bool {
    STOP_WORDS.contains(&word)
}

/// Okapi BM25 with the usual constants.
fn bm25(
    terms: &[String],
    document: &[String],
    document_frequency: &std::collections::HashMap<&str, usize>,
    total: f64,
    average_length: f64,
) -> f64 {
    const K1: f64 = 1.2;
    const B: f64 = 0.75;
    let length = document.len() as f64;
    let mut score = 0.0;
    for term in terms {
        let frequency = document.iter().filter(|t| *t == term).count() as f64;
        if frequency == 0.0 {
            continue;
        }
        let df = *document_frequency.get(term.as_str()).unwrap_or(&0) as f64;
        // A term in every window says nothing about which window to send.
        let idf = ((total - df + 0.5) / (df + 0.5) + 1.0).ln();
        let norm = K1 * (1.0 - B + B * length / average_length.max(1.0));
        score += idf * frequency * (K1 + 1.0) / (frequency + norm);
    }
    score
}
