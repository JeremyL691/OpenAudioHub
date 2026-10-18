//! Pure helpers: reading a model's reply, cleaning titles, splitting long transcripts,
//! filling templates (spec/ai.md "Output read back", "Long transcripts", "Title generation").

use serde_json::Value;

use super::prompts::PLACEHOLDER;

/// What a summary reply holds.
#[derive(Debug, Default, PartialEq)]
pub struct Reply {
    pub summary: String,
    pub key_points: Vec<String>,
    pub action_items: Vec<String>,
}

/// Characters trimmed from the ends of a title (quotes, markdown emphasis).
const EDGE: &[char] = &[
    '"', '\'', '“', '”', '‘', '’', '「', '」', '『', '』', '«', '»', '*', '#', '`', '_',
];
const TITLE_MAX: usize = 60;
const TITLE_CUT: usize = 57;

/// Removes one leading and one trailing code fence (json, markdown, md, or none).
pub fn strip_fences(text: &str) -> &str {
    let mut t = text.trim();
    if let Some(rest) = t.strip_prefix("```") {
        let rest = match rest.split_once('\n') {
            Some((tag, body))
                if matches!(
                    tag.trim().to_ascii_lowercase().as_str(),
                    "" | "json" | "markdown" | "md"
                ) =>
            {
                body
            }
            _ => rest,
        };
        t = rest;
    }
    if let Some(inner) = t.trim_end().strip_suffix("```") {
        t = inner;
    }
    t.trim()
}

fn string_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// A JSON object reply gives its `summary`, `keyPoints` and `actionItems`. Any other reply
/// is the summary as written.
pub fn parse_reply(raw: &str) -> Reply {
    let body = strip_fences(raw);
    if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(body)
        && let Some(summary) = map
            .get("summary")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
    {
        return Reply {
            summary: summary.to_owned(),
            key_points: string_list(map.get("keyPoints")),
            action_items: string_list(map.get("actionItems")),
        };
    }
    Reply {
        summary: body.to_owned(),
        ..Reply::default()
    }
}

fn trim_edges(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || EDGE.contains(&c))
}

fn strip_label(s: &str) -> &str {
    if s.get(..6).is_some_and(|p| p.eq_ignore_ascii_case("title:")) {
        &s[6..]
    } else {
        s
    }
}

/// One clean line of plain text, or `None` when nothing usable is left. A JSON answer
/// contributes its `title` field, never its raw text.
pub fn clean_title(reply: &str) -> Option<String> {
    let body = strip_fences(reply);
    let raw = if body.starts_with('{') {
        serde_json::from_str::<Value>(body)
            .ok()?
            .get("title")?
            .as_str()?
            .to_owned()
    } else {
        body.lines()
            .map(str::trim)
            .find(|l| !l.is_empty())?
            .to_owned()
    };
    let title = trim_edges(&raw);
    let title = trim_edges(strip_label(title));
    let title: String = title
        .chars()
        .filter(|c| !matches!(c, ':' | ';' | '：' | '；'))
        .collect();
    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    let title = trim_edges(&title);
    if title.is_empty() {
        return None;
    }
    if title.chars().count() > TITLE_MAX {
        let cut: String = title.chars().take(TITLE_CUT).collect();
        return Some(format!("{cut}..."));
    }
    Some(title.to_owned())
}

/// The first `limit` characters, with `...` when cut.
pub fn excerpt(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_owned();
    }
    let cut: String = text.chars().take(limit).collect();
    format!("{cut}...")
}

/// Splits into ordered parts of at most `limit` characters: at line ends first, then at
/// sentence ends. A sentence longer than the limit is cut.
pub fn split_parts(text: &str, limit: usize) -> Vec<String> {
    if text.chars().count() <= limit {
        return vec![text.to_owned()];
    }
    let mut pieces: Vec<String> = Vec::new();
    for line in text.split_inclusive('\n') {
        if line.chars().count() <= limit {
            pieces.push(line.to_owned());
            continue;
        }
        for sentence in split_sentences(line) {
            let chars: Vec<char> = sentence.chars().collect();
            for chunk in chars.chunks(limit) {
                pieces.push(chunk.iter().collect());
            }
        }
    }
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut current_len = 0;
    for piece in pieces {
        let n = piece.chars().count();
        if current_len + n > limit && !current.is_empty() {
            parts.push(std::mem::take(&mut current));
            current_len = 0;
        }
        current.push_str(&piece);
        current_len += n;
    }
    if !current.is_empty() {
        parts.push(current);
    }
    parts
}

fn split_sentences(line: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    for (i, c) in line.char_indices() {
        if matches!(c, '.' | '!' | '?' | '。' | '！' | '？') {
            let end = i + c.len_utf8();
            out.push(&line[start..end]);
            start = end;
        }
    }
    if start < line.len() {
        out.push(&line[start..]);
    }
    out
}

/// Time at `offset` characters into a text of `total` characters, spreading the duration evenly.
pub fn offset_ms(duration_ms: i64, offset: usize, total: usize) -> i64 {
    if total == 0 {
        return 0;
    }
    (duration_ms as i128 * offset as i128 / total as i128) as i64
}

/// `m:ss`, or `h:mm:ss` from one hour on.
pub fn clock(ms: i64) -> String {
    let secs = ms.max(0) / 1000;
    let (h, m, s) = (secs / 3600, secs % 3600 / 60, secs % 60);
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m}:{s:02}")
    }
}

/// Puts `input` where the placeholder is. A template without one gets the input after it.
pub fn fill(template: &str, input: &str) -> String {
    if template.contains(PLACEHOLDER) {
        template.replace(PLACEHOLDER, input)
    } else {
        format!("{template}\n\n{input}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fences_are_removed_only_at_the_ends() {
        assert_eq!(strip_fences("```json\n{\"a\":1}\n```"), "{\"a\":1}");
        assert_eq!(strip_fences("```md\n# Hi\n```"), "# Hi");
        assert_eq!(strip_fences("```\nplain\n```"), "plain");
        assert_eq!(strip_fences("no fences"), "no fences");
    }

    #[test]
    fn json_reply_gives_its_fields() {
        let r = parse_reply(
            "```json\n{\"summary\":\"Done.\",\"keyPoints\":[\"A\",\" \",3],\"actionItems\":[\"Call\"]}\n```",
        );
        assert_eq!(r.summary, "Done.");
        assert_eq!(r.key_points, vec!["A"]);
        assert_eq!(r.action_items, vec!["Call"]);
    }

    #[test]
    fn other_replies_are_the_summary_as_written() {
        let r = parse_reply("## Overview\nText.");
        assert_eq!(r.summary, "## Overview\nText.");
        assert!(r.key_points.is_empty() && r.action_items.is_empty());
        let r = parse_reply("{\"other\": 1}");
        assert_eq!(r.summary, "{\"other\": 1}");
    }

    #[test]
    fn title_cleanup_handles_labels_quotes_and_json() {
        assert_eq!(
            clean_title("Title: \"Team Sync: Q4\"").as_deref(),
            Some("Team Sync Q4")
        );
        assert_eq!(
            clean_title("**Title:** Budget Review").as_deref(),
            Some("Budget Review")
        );
        assert_eq!(
            clean_title("```json\n{\"title\": \"Contract Title\"}\n```").as_deref(),
            Some("Contract Title")
        );
        assert_eq!(
            clean_title("{\"title\": \"A\", \"summary\": \"x\"}").as_deref(),
            Some("A")
        );
        assert_eq!(clean_title("{\"summary\": \"no title\"}"), None);
        assert_eq!(clean_title("   \n  "), None);
        assert_eq!(clean_title(":;"), None);
        assert_eq!(
            clean_title("Line one\nLine two").as_deref(),
            Some("Line one")
        );
    }

    #[test]
    fn long_titles_are_cut_to_sixty() {
        let long = "x".repeat(80);
        let title = clean_title(&long).unwrap();
        assert_eq!(title.chars().count(), 60);
        assert!(title.ends_with("..."));
        let exact = "y".repeat(60);
        assert_eq!(clean_title(&exact).unwrap(), exact);
    }

    #[test]
    fn split_keeps_order_and_limit() {
        let text = "Alpha line one.\nBeta line two is here.\nGamma. Delta. Epsilon.\n";
        assert_eq!(split_parts(text, 1000), vec![text.to_owned()]);
        let parts = split_parts(text, 20);
        assert!(parts.iter().all(|p| p.chars().count() <= 20));
        assert_eq!(parts.concat(), text);
    }

    #[test]
    fn overlong_sentence_is_cut() {
        let text = "a".repeat(25);
        let parts = split_parts(&text, 10);
        assert_eq!(
            parts.iter().map(|p| p.chars().count()).collect::<Vec<_>>(),
            vec![10, 10, 5]
        );
    }

    #[test]
    fn clock_and_offsets() {
        assert_eq!(clock(65_000), "1:05");
        assert_eq!(clock(3_725_000), "1:02:05");
        assert_eq!(offset_ms(100_000, 50, 200), 25_000);
        assert_eq!(offset_ms(100_000, 0, 0), 0);
    }

    #[test]
    fn fill_replaces_every_placeholder() {
        assert_eq!(fill("A {transcription} B {transcription}", "X"), "A X B X");
        assert_eq!(fill("No slot", "X"), "No slot\n\nX");
        assert_eq!(
            fill("T {transcription}", "{transcription}"),
            "T {transcription}"
        );
    }
}
