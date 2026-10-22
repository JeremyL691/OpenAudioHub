//! Tests for the recording chat module (spec/recording-chat.md).

use std::collections::BTreeSet;

use super::capabilities::{Effort, EffortChoice, EffortDecision, EffortSupport, resolve};
use super::{citations, context, revision};

fn levels(list: &[Effort]) -> EffortSupport {
    EffortSupport::Levels(list.iter().copied().collect::<BTreeSet<_>>())
}

fn choice(text: &str) -> EffortChoice {
    EffortChoice::parse(text).unwrap_or_else(|| panic!("{text} is a level"))
}

#[test]
fn every_level_rounds_up_to_the_closest_supported_one() {
    // The levels a provider publishes, and what each choice becomes.
    let cases = [
        ("minimal", EffortDecision::Send(Effort::Minimal)),
        ("low", EffortDecision::Send(Effort::Low)),
        ("medium", EffortDecision::Send(Effort::High)),
        ("high", EffortDecision::Send(Effort::High)),
        ("xhigh", EffortDecision::Capped(Effort::High)),
        ("max", EffortDecision::Capped(Effort::High)),
    ];
    let support = levels(&[Effort::Minimal, Effort::Low, Effort::High]);
    for (text, expected) in cases {
        assert_eq!(resolve(choice(text), &support), expected, "choice {text}");
    }
}

#[test]
fn max_is_sent_when_the_model_supports_it() {
    let support = levels(&[Effort::High, Effort::Max]);
    assert_eq!(
        resolve(choice("max"), &support),
        EffortDecision::Send(Effort::Max)
    );
    assert_eq!(
        resolve(choice("xhigh"), &support),
        EffortDecision::Send(Effort::Max)
    );
    // The closest level at or above the choice wins, not the highest one.
    assert_eq!(
        resolve(choice("medium"), &support),
        EffortDecision::Send(Effort::High)
    );
}

#[test]
fn a_model_with_an_unknown_level_set_sends_nothing() {
    for text in ["minimal", "medium", "max"] {
        assert_eq!(
            resolve(choice(text), &EffortSupport::Unknown),
            EffortDecision::Unknown,
            "choice {text}"
        );
    }
}

#[test]
fn a_model_that_takes_no_level_sends_nothing_and_says_so() {
    for text in ["minimal", "high", "max"] {
        assert_eq!(
            resolve(choice(text), &levels(&[])),
            EffortDecision::NotSupported,
            "choice {text}"
        );
    }
}

#[test]
fn default_sends_nothing_whatever_the_model_supports() {
    for support in [
        levels(&[Effort::Minimal, Effort::Max]),
        levels(&[]),
        EffortSupport::Unknown,
    ] {
        assert_eq!(
            resolve(choice("default"), &support),
            EffortDecision::Default
        );
    }
}

#[test]
fn an_unknown_level_is_not_a_choice() {
    for text in ["", "MIDDLE", "ultra", "xhigh "] {
        assert_eq!(EffortChoice::parse(text), None, "{text} is not a level");
    }
    for effort in [
        Effort::Minimal,
        Effort::Low,
        Effort::Medium,
        Effort::High,
        Effort::Xhigh,
        Effort::Max,
    ] {
        assert_eq!(
            EffortChoice::parse(effort.as_str()),
            Some(EffortChoice::Level(effort))
        );
    }
}

#[test]
fn a_choice_above_every_supported_level_takes_the_highest() {
    let support = levels(&[Effort::Minimal, Effort::Low]);
    assert_eq!(
        resolve(choice("medium"), &support),
        EffortDecision::Capped(Effort::Low)
    );
    assert_eq!(
        resolve(choice("max"), &support),
        EffortDecision::Capped(Effort::Low)
    );
}

fn rows_units(rows: serde_json::Value, timing: revision::Timing) -> Vec<context::Unit> {
    context::units(
        "Text that is not used while the timeline is.",
        Some(&rows),
        timing,
    )
}

#[test]
fn each_timeline_row_is_cited_by_its_own_index() {
    let rows = serde_json::json!([
        { "start_ms": 0, "end_ms": 4000, "speaker_id": "SPEAKER_00",
          "text": "We agreed to ship the release on Friday, after the final review." },
        { "start_ms": 4000, "end_ms": 9000, "speaker_id": "SPEAKER_01",
          "text": "The budget for the whole quarter is ten thousand dollars in total." }
    ]);
    let units = rows_units(rows, revision::Timing::Native);
    assert_eq!(units.len(), 2);
    assert_eq!(units[1].id(), "src_2");
    assert_eq!(
        units[1].place,
        context::Place::Segments { first: 1, last: 1 }
    );
    assert_eq!(
        (units[1].start_ms, units[1].end_ms),
        (Some(4000), Some(9000))
    );
    assert_eq!(units[1].speaker.as_deref(), Some("SPEAKER_01"));
    assert!(!units[1].approximate);
}

#[test]
fn short_rows_of_one_speaker_are_cited_together() {
    let rows = serde_json::json!([
        { "start_ms": 0, "end_ms": 1000, "speaker_id": "SPEAKER_00", "text": "Yes." },
        { "start_ms": 1000, "end_ms": 2000, "speaker_id": "SPEAKER_00", "text": "Right." },
        { "start_ms": 2000, "end_ms": 3000, "speaker_id": "SPEAKER_00", "text": "Okay, let's go." },
        { "start_ms": 3000, "end_ms": 4000, "speaker_id": "SPEAKER_01", "text": "Next." }
    ]);
    let units = rows_units(rows, revision::Timing::Native);
    assert_eq!(units.len(), 2, "another speaker starts a new unit");
    assert_eq!(units[0].text, "Yes. Right. Okay, let's go.");
    assert_eq!(
        units[0].place,
        context::Place::Segments { first: 0, last: 2 }
    );
    assert_eq!((units[0].start_ms, units[0].end_ms), (Some(0), Some(3000)));
    assert_eq!(
        units[1].place,
        context::Place::Segments { first: 3, last: 3 }
    );
}

#[test]
fn rows_far_apart_or_already_long_are_not_joined() {
    let apart = serde_json::json!([
        { "start_ms": 0, "end_ms": 1000, "text": "Yes." },
        { "start_ms": 25_000, "end_ms": 26_000, "text": "Right." }
    ]);
    assert_eq!(rows_units(apart, revision::Timing::Native).len(), 2);
    let long = serde_json::json!([
        { "start_ms": 0, "end_ms": 5000,
          "text": "This row is long enough on its own to be a clear and useful citation." },
        { "start_ms": 5000, "end_ms": 6000, "text": "Yes." }
    ]);
    assert_eq!(rows_units(long, revision::Timing::Native).len(), 2);
}

#[test]
fn chinese_rows_are_joined_without_a_space() {
    let rows = serde_json::json!([
        { "start_ms": 0, "end_ms": 1000, "text": "好的" },
        { "start_ms": 1000, "end_ms": 3000, "text": "我们开始" }
    ]);
    let units = rows_units(rows, revision::Timing::Native);
    assert_eq!(units.len(), 1);
    assert_eq!(units[0].text, "好的我们开始");
}

#[test]
fn a_row_without_words_or_time_is_skipped_but_keeps_the_indexes() {
    let rows = serde_json::json!([
        { "start_ms": 0, "end_ms": 1000, "text": "   " },
        { "text": "No time on this row." },
        { "start_ms": 2000, "end_ms": 3000, "text": "The only row that can be cited." }
    ]);
    let units = rows_units(rows, revision::Timing::Native);
    assert_eq!(units.len(), 1);
    assert_eq!(units[0].id(), "src_1");
    assert_eq!(
        units[0].place,
        context::Place::Segments { first: 2, last: 2 }
    );
}

#[test]
fn every_unit_starts_when_its_own_row_starts() {
    // Short filler rows used to pull later citations back to the first one. Each row now keeps
    // its own time.
    let rows = serde_json::json!([
        { "start_ms": 999_000, "end_ms": 999_400, "text": "要" },
        { "start_ms": 1_000_000, "end_ms": 1_200_000, "text": "为了体现项目的规范化 我们先讲背景" },
        { "start_ms": 1_400_000, "end_ms": 1_400_400, "text": "要" },
        { "start_ms": 1_500_000, "end_ms": 1_700_000, "text": "接下来是第二部分的内容" },
        { "start_ms": 1_800_000, "end_ms": 1_800_400, "text": "要" },
        { "start_ms": 1_900_000, "end_ms": 2_100_000, "text": "最后我们确认一下时间安排" }
    ]);
    let units = rows_units(rows.clone(), revision::Timing::Native);
    for unit in &units {
        let context::Place::Segments { first, .. } = unit.place else {
            panic!("a timed transcript is cited by its rows");
        };
        assert_eq!(unit.start_ms, rows[first]["start_ms"].as_i64());
    }
    let second = units
        .iter()
        .find(|u| u.text == "接下来是第二部分的内容")
        .expect("the row is its own unit");
    assert_eq!(second.start_ms, Some(1_500_000));
}

#[test]
fn a_corrected_timeline_gives_approximate_units() {
    let rows = serde_json::json!([{ "start_ms": 1500, "end_ms": 4000, "text": "Hello." }]);
    let units = rows_units(rows, revision::Timing::Normalized);
    assert!(units[0].approximate);
    assert_eq!(units[0].start_ms, Some(1500));
}

#[test]
fn without_a_usable_timeline_the_lines_are_cited() {
    let rows = serde_json::json!([{ "start_ms": 0, "end_ms": 1000, "text": "Hello." }]);
    let text = "First line.\n\n   Second line.  \n";
    let units = context::units(text, Some(&rows), revision::Timing::None);
    assert_eq!(units.len(), 2, "blank lines are skipped");
    assert_eq!(
        units[1].place,
        context::Place::Line {
            index: 1,
            start: 0,
            end: 12
        }
    );
    assert_eq!(units[1].text, "Second line.");
    assert_eq!(units[1].start_ms, None);
    // An empty timeline falls back to the lines too.
    let empty = serde_json::json!([]);
    let units = context::units(text, Some(&empty), revision::Timing::Native);
    assert!(matches!(units[0].place, context::Place::Line { .. }));
}

#[test]
fn a_long_line_is_cited_by_its_sentences() {
    let line = "这是一句话。".repeat(100);
    let units = context::units(&line, None, revision::Timing::None);
    assert_eq!(units.len(), 2);
    assert_eq!(
        units[0].place,
        context::Place::Line {
            index: 0,
            start: 0,
            end: 396
        },
        "the cut falls after the last sentence that fits"
    );
    assert_eq!(
        units[1].place,
        context::Place::Line {
            index: 0,
            start: 396,
            end: 600
        }
    );
    assert!(units[0].text.ends_with('。'));
}

#[test]
fn line_ranges_count_utf16_units() {
    // The emoji is two UTF-16 units, so every later offset moves by one.
    let line = format!("😀{}", "Ab. ".repeat(150));
    let units = context::units(&line, None, revision::Timing::None);
    assert_eq!(units.len(), 2);
    assert_eq!(
        units[0].place,
        context::Place::Line {
            index: 0,
            start: 0,
            end: 401
        }
    );
    assert_eq!(
        units[1].place,
        context::Place::Line {
            index: 0,
            start: 401,
            end: 601
        }
    );
}

#[test]
fn a_sentence_longer_than_a_unit_is_cut_where_the_limit_falls() {
    let units = context::units(&"a".repeat(1000), None, revision::Timing::None);
    let sizes: Vec<usize> = units.iter().map(|u| u.text.len()).collect();
    assert_eq!(sizes, vec![400, 400, 200]);
}

#[test]
fn the_model_reads_each_unit_with_its_time_and_speaker() {
    let rows = serde_json::json!([
        { "start_ms": 194_000, "end_ms": 196_000, "speaker_id": "SPEAKER_00", "text": "Ship it." }
    ]);
    let units = rows_units(rows, revision::Timing::Native);
    assert_eq!(units[0].render(), "[src_1] 3:14 Speaker 1: Ship it.");
    let lines = context::units("Plain words.", None, revision::Timing::None);
    assert_eq!(lines[0].render(), "[src_1] Plain words.");
    assert_eq!(context::clock(3_723_000), "1:02:03");
}

fn transcript(text: &str, timeline_source: Option<&str>) -> revision::Transcript {
    revision::Transcript {
        id: "tr_1".into(),
        source: "openaudiohub".into(),
        text: text.into(),
        timeline: Some(serde_json::json!([{ "start_ms": 0, "end_ms": 1000, "text": "Hello." }])),
        timeline_source: timeline_source.map(str::to_owned),
        created_at: 1_700_000_000_000,
    }
}

#[test]
fn the_same_transcript_gives_the_same_revision() {
    let one = revision::Revision::of("usr_1", "rec_1", &transcript("Hello.", Some("native")));
    let two = revision::Revision::of("usr_1", "rec_1", &transcript("Hello.", Some("native")));
    assert_eq!(one.hash, two.hash);
    assert_eq!(one.timing, revision::Timing::Native);
}

#[test]
fn corrected_timings_make_a_new_revision() {
    // The words are the same; only the timings changed, so an answer that cited the old times
    // must not still count as current.
    let native = revision::Revision::of("usr_1", "rec_1", &transcript("Hello.", Some("native")));
    let normalized =
        revision::Revision::of("usr_1", "rec_1", &transcript("Hello.", Some("normalized")));
    assert_ne!(native.hash, normalized.hash);
    assert_eq!(normalized.timing, revision::Timing::Normalized);
}

#[test]
fn another_user_or_recording_is_another_revision() {
    let base = revision::Revision::of("usr_1", "rec_1", &transcript("Hello.", Some("native")));
    assert_ne!(
        base.hash,
        revision::Revision::of("usr_2", "rec_1", &transcript("Hello.", Some("native"))).hash
    );
    assert_ne!(
        base.hash,
        revision::Revision::of("usr_1", "rec_2", &transcript("Hello.", Some("native"))).hash
    );
}

#[test]
fn a_changed_field_cannot_hide_behind_the_same_bytes() {
    // Moving a character from the text into the source keeps the total bytes; the revision
    // must still change, which is why every field is length-prefixed.
    let one = transcript("ab", Some("native"));
    let mut two = transcript("a", Some("native"));
    two.source = "openaudiohubb".into();
    let a = revision::Revision::of("usr_1", "rec_1", &one);
    let b = revision::Revision::of("usr_1", "rec_1", &two);
    assert_ne!(a.hash, b.hash);
}

#[test]
fn a_transcript_without_a_usable_timeline_has_no_time_for_a_citation() {
    for source in [None, Some(""), Some("guessed"), Some("NATIVE")] {
        let timing = revision::Timing::of(source);
        assert_eq!(timing, revision::Timing::None, "{source:?}");
        assert!(!timing.has_time());
    }
    assert!(revision::Timing::of(Some("native")).has_time());
    assert!(revision::Timing::of(Some("normalized")).has_time());
}

fn cited_units() -> Vec<context::Unit> {
    let rows = serde_json::json!([
        { "start_ms": 61_000, "end_ms": 65_000, "speaker_id": "SPEAKER_00",
          "text": "We agreed to ship the release on Friday, after the final review." },
        { "start_ms": 120_000, "end_ms": 124_000, "speaker_id": "SPEAKER_01",
          "text": "The budget for the whole quarter is ten thousand dollars in total." }
    ]);
    context::units("", Some(&rows), revision::Timing::Native)
}

#[test]
fn a_cited_unit_points_at_its_own_rows() {
    let cited = citations::verify("The budget is set [src_2].", &cited_units());
    assert_eq!(cited.len(), 1);
    let citation = &cited[0];
    assert_eq!(citation.source_id, "src_2");
    assert_eq!(
        citation.quote,
        "The budget for the whole quarter is ten thousand dollars in total."
    );
    assert_eq!(
        (citation.start_ms, citation.end_ms),
        (Some(120_000), Some(124_000))
    );
    assert_eq!(
        (citation.segment_start, citation.segment_end),
        (Some(1), Some(1))
    );
    assert_eq!(citation.speaker.as_deref(), Some("SPEAKER_01"));
    assert_eq!(citation.line, None);
}

#[test]
fn a_cited_line_points_at_its_line() {
    let units = context::units("First line.\nSecond line.", None, revision::Timing::None);
    let cited = citations::verify("As said [src_2].", &units);
    assert_eq!(cited.len(), 1);
    assert_eq!(cited[0].quote, "Second line.");
    assert_eq!(
        (cited[0].line, cited[0].line_start, cited[0].line_end),
        (Some(1), Some(0), Some(12))
    );
    assert_eq!((cited[0].start_ms, cited[0].segment_start), (None, None));
}

#[test]
fn a_source_id_the_model_invented_is_dropped() {
    let units = cited_units();
    for answer in [
        "Nothing supports this [src_9].",
        "Nothing supports this [src_0].",
        "Nothing supports this [1].",
        "Nothing supports this.",
    ] {
        assert!(citations::verify(answer, &units).is_empty(), "{answer}");
    }
}

#[test]
fn an_id_is_looked_up_by_its_number() {
    let units = cited_units();
    assert_eq!(
        citations::unit_by_id(&units, "src_2").map(|u| u.ordinal),
        Some(1)
    );
    for id in ["src_0", "src_3", "src_x", "src_", "2"] {
        assert!(citations::unit_by_id(&units, id).is_none(), "{id}");
    }
}

#[test]
fn an_incomplete_or_malformed_marker_is_not_a_citation() {
    let units = cited_units();
    for answer in [
        "Half [src_",
        "Broken [src_1",
        "Empty []",
        "Spaced [ src_ 1 ]",
        "Mixed [src_1, see the notes]",
    ] {
        assert!(
            citations::verify(answer, &units).is_empty(),
            "{answer} must not cite anything"
        );
    }
}

#[test]
fn several_ids_in_one_marker_are_all_cited() {
    let units = cited_units();
    for answer in [
        "Both [src_2, src_1].",
        "Both [src_2，src_1].",
        "Both 【src_2】【src_1】.",
        "Both [src_2][src_1] and again [src_2].",
    ] {
        let ids: Vec<String> = citations::verify(answer, &units)
            .into_iter()
            .map(|c| c.source_id)
            .collect();
        assert_eq!(ids, vec!["src_2", "src_1"], "{answer}");
    }
}

#[test]
fn a_time_the_model_writes_itself_is_not_used() {
    // The model's own "[01:05]" is text, not a source id, so it never becomes a jump target.
    let cited = citations::verify("Around [01:05] we agreed [src_1].", &cited_units());
    assert_eq!(cited.len(), 1);
    assert_eq!(cited[0].start_ms, Some(61_000));
}

#[test]
fn a_text_only_citation_points_nowhere() {
    let cited = citations::verify("[src_1]", &cited_units());
    let shown = cited[0].text_only();
    assert_eq!(shown.quote, cited[0].quote);
    assert_eq!(shown.speaker, cited[0].speaker);
    assert_eq!((shown.start_ms, shown.end_ms), (None, None));
    assert_eq!((shown.segment_start, shown.segment_end), (None, None));
    assert_eq!(
        (shown.line, shown.line_start, shown.line_end),
        (None, None, None)
    );
    assert!(!shown.approximate);
}

#[test]
fn saved_citations_read_back_in_both_shapes() {
    let cited = citations::verify("[src_1]", &cited_units());
    let stored = citations::Stored {
        citations: cited.clone(),
        partial: true,
    };
    assert_eq!(citations::from_stored(&stored.to_value()), stored);

    // A list on its own, in the shape older turns were saved in, still reads.
    let bare = serde_json::json!([{
        "sourceId": "src_1",
        "quote": "Older words.",
        "startChar": 0,
        "endChar": 12,
        "startMs": 0,
        "endMs": 4000,
        "approximate": false
    }]);
    let read = citations::from_stored(&bare);
    assert!(!read.partial);
    assert_eq!(read.citations.len(), 1);
    assert_eq!(read.citations[0].quote, "Older words.");
    assert_eq!(read.citations[0].segment_start, None);
    assert_eq!(read.citations[0].speaker, None);
}

// ---- storage ----

mod storage {
    use super::*;
    use crate::chat::store::{self, Fence, NewTurn, TurnRefusal, TurnState};
    use crate::crypto::FieldKey;
    use sqlx::SqlitePool;

    const KEY: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

    async fn db() -> (SqlitePool, FieldKey) {
        let pool = crate::db::open_memory().await.expect("in-memory database");
        sqlx::query(
            "INSERT INTO users (id, email, created_at, updated_at) VALUES ('u', 'u@test', 0, 0)",
        )
        .execute(&pool)
        .await
        .expect("user");
        sqlx::query(
            "INSERT INTO recordings (id, user_id, device_sn, plaud_file_id, filename, duration,
             start_time, end_time, filesize, file_md5, storage_type, storage_path, plaud_version,
             created_at, updated_at)
             VALUES ('r', 'u', 'sn', 'pf', 'name', 1000, 0, 1000, 1, 'md5', 'local', '/tmp/a', 'v', 0, 0)",
        )
        .execute(&pool)
        .await
        .expect("recording");
        (pool, FieldKey::from_hex(KEY).expect("test key"))
    }

    fn new_turn<'a>(chat: &'a str, request: &'a str) -> NewTurn<'a> {
        NewTurn {
            chat_id: chat,
            recording_id: "r",
            user_id: "u",
            request_id: request,
            generation: 0,
            question: "What did we agree?",
            revision: "rv_1",
            transcript_id: Some("tr_1"),
        }
    }

    #[tokio::test]
    async fn a_question_is_stored_encrypted_and_read_back() {
        let (pool, key) = db().await;
        let chat = store::conversation_or_create(&pool, "u", "r")
            .await
            .unwrap();
        let turn = store::create_turn(&pool, &key, &new_turn(&chat.id, "req_1"))
            .await
            .unwrap()
            .expect("turn created");
        assert_eq!(turn.state, TurnState::Pending);

        let stored: String =
            sqlx::query_scalar("SELECT question FROM recording_chat_turns WHERE id = ?")
                .bind(&turn.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(
            stored.starts_with("v1:"),
            "the question must be stored encrypted"
        );
        assert!(!stored.contains("What did we agree"));

        let read = store::turn(&pool, &key, "u", "r", &turn.id)
            .await
            .unwrap()
            .expect("turn read back");
        assert_eq!(read.question, "What did we agree?");
        assert_eq!(read.state, TurnState::Pending);
    }

    #[tokio::test]
    async fn only_one_answer_runs_in_a_conversation() {
        let (pool, key) = db().await;
        let chat = store::conversation_or_create(&pool, "u", "r")
            .await
            .unwrap();
        store::create_turn(&pool, &key, &new_turn(&chat.id, "req_1"))
            .await
            .unwrap()
            .unwrap();
        let second = store::create_turn(&pool, &key, &new_turn(&chat.id, "req_2"))
            .await
            .unwrap();
        assert_eq!(second.err(), Some(TurnRefusal::Busy));
    }

    #[tokio::test]
    async fn a_repeated_request_finds_the_turn_it_created() {
        let (pool, key) = db().await;
        let chat = store::conversation_or_create(&pool, "u", "r")
            .await
            .unwrap();
        let first = store::create_turn(&pool, &key, &new_turn(&chat.id, "req_1"))
            .await
            .unwrap()
            .unwrap();
        // The route looks the request up before creating anything, so a retry costs no model call.
        let found = store::turn_by_request(&pool, &key, &chat.id, "req_1")
            .await
            .unwrap()
            .expect("the turn the request already created");
        assert_eq!(found.id, first.id);
    }

    #[tokio::test]
    async fn a_cleared_conversation_refuses_the_old_generation() {
        let (pool, key) = db().await;
        let chat = store::conversation_or_create(&pool, "u", "r")
            .await
            .unwrap();
        store::clear(&pool, "u", "r").await.unwrap();
        let refused = store::create_turn(&pool, &key, &new_turn(&chat.id, "req_1"))
            .await
            .unwrap();
        assert_eq!(refused.err(), Some(TurnRefusal::Stale));
    }

    #[tokio::test]
    async fn a_run_from_a_cleared_conversation_cannot_save() {
        let (pool, key) = db().await;
        let chat = store::conversation_or_create(&pool, "u", "r")
            .await
            .unwrap();
        let turn = store::create_turn(&pool, &key, &new_turn(&chat.id, "req_1"))
            .await
            .unwrap()
            .unwrap();
        let fence = Fence {
            turn_id: &turn.id,
            generation: 0,
            attempt: 1,
            revision: "rv_1",
            lease_owner: "run_1",
        };
        assert!(
            store::start_run(
                &pool,
                &turn.id,
                0,
                1,
                "rv_1",
                "run_1",
                i64::MAX,
                &store::ModelNote {
                    provider: Some("OpenAI"),
                    model: Some("chat-1"),
                    effort_requested: Some("medium"),
                    effort_sent: Some("high"),
                    effort_known: true,
                },
            )
            .await
            .unwrap()
        );
        assert!(
            store::save_partial(&pool, &key, &fence, "Half an answer.", None)
                .await
                .unwrap()
        );

        store::clear(&pool, "u", "r").await.unwrap();
        assert!(
            !store::finish(&pool, &key, &fence, "A late answer.", &[])
                .await
                .unwrap(),
            "a cleared conversation must refuse the late answer"
        );
    }

    #[tokio::test]
    async fn a_replaced_revision_cannot_be_written_to() {
        let (pool, key) = db().await;
        let chat = store::conversation_or_create(&pool, "u", "r")
            .await
            .unwrap();
        let turn = store::create_turn(&pool, &key, &new_turn(&chat.id, "req_1"))
            .await
            .unwrap()
            .unwrap();
        store::start_run(
            &pool,
            &turn.id,
            0,
            1,
            "rv_1",
            "run_1",
            i64::MAX,
            &store::ModelNote {
                provider: None,
                model: None,
                effort_requested: None,
                effort_sent: None,
                effort_known: false,
            },
        )
        .await
        .unwrap();
        // A run that recorded another revision is a different run: its fence must not match.
        let other = Fence {
            turn_id: &turn.id,
            generation: 0,
            attempt: 1,
            revision: "rv_2",
            lease_owner: "run_1",
        };
        assert!(
            !store::finish(&pool, &key, &other, "Wrong version.", &[])
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn a_finished_turn_is_never_overwritten() {
        let (pool, key) = db().await;
        let chat = store::conversation_or_create(&pool, "u", "r")
            .await
            .unwrap();
        let turn = store::create_turn(&pool, &key, &new_turn(&chat.id, "req_1"))
            .await
            .unwrap()
            .unwrap();
        store::start_run(
            &pool,
            &turn.id,
            0,
            1,
            "rv_1",
            "run_1",
            i64::MAX,
            &store::ModelNote {
                provider: None,
                model: None,
                effort_requested: None,
                effort_sent: None,
                effort_known: false,
            },
        )
        .await
        .unwrap();
        let fence = Fence {
            turn_id: &turn.id,
            generation: 0,
            attempt: 1,
            revision: "rv_1",
            lease_owner: "run_1",
        };
        assert!(
            store::finish(&pool, &key, &fence, "The answer.", &[])
                .await
                .unwrap()
        );
        assert!(
            !store::end_run(
                &pool,
                &key,
                Some(&fence),
                &turn.id,
                TurnState::Failed,
                Some("X"),
                Some("late")
            )
            .await
            .unwrap(),
            "a late failure must not replace a completed answer"
        );
        let read = store::turn(&pool, &key, "u", "r", &turn.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(read.state, TurnState::Completed);
        assert_eq!(read.answer, "The answer.");
    }

    #[tokio::test]
    async fn answers_are_stored_encrypted() {
        let (pool, key) = db().await;
        let chat = store::conversation_or_create(&pool, "u", "r")
            .await
            .unwrap();
        let turn = store::create_turn(&pool, &key, &new_turn(&chat.id, "req_1"))
            .await
            .unwrap()
            .unwrap();
        store::start_run(
            &pool,
            &turn.id,
            0,
            1,
            "rv_1",
            "run_1",
            i64::MAX,
            &store::ModelNote {
                provider: None,
                model: None,
                effort_requested: None,
                effort_sent: None,
                effort_known: false,
            },
        )
        .await
        .unwrap();
        let fence = Fence {
            turn_id: &turn.id,
            generation: 0,
            attempt: 1,
            revision: "rv_1",
            lease_owner: "run_1",
        };
        store::finish(&pool, &key, &fence, "The secret answer.", &[])
            .await
            .unwrap();
        let stored: String =
            sqlx::query_scalar("SELECT answer FROM recording_chat_turns WHERE id = ?")
                .bind(&turn.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(
            stored.starts_with("v1:"),
            "the answer must be stored encrypted"
        );
        assert!(!stored.contains("The secret answer"));
    }

    #[tokio::test]
    async fn a_lease_that_ran_out_can_no_longer_save() {
        let (pool, key) = db().await;
        let chat = store::conversation_or_create(&pool, "u", "r")
            .await
            .unwrap();
        let turn = store::create_turn(&pool, &key, &new_turn(&chat.id, "req_1"))
            .await
            .unwrap()
            .unwrap();
        store::start_run(
            &pool,
            &turn.id,
            0,
            1,
            "rv_1",
            "run_1",
            i64::MAX,
            &store::ModelNote {
                provider: None,
                model: None,
                effort_requested: None,
                effort_sent: None,
                effort_known: false,
            },
        )
        .await
        .unwrap();
        // The deadline has passed, so the run no longer holds the turn.
        let broken = Fence {
            turn_id: &turn.id,
            generation: 0,
            attempt: 1,
            revision: "rv_1",
            lease_owner: "run_1",
        };
        sqlx::query("UPDATE recording_chat_turns SET lease_until = 0 WHERE id = ?")
            .bind(&turn.id)
            .execute(&pool)
            .await
            .unwrap();
        assert!(
            !store::save_partial(&pool, &key, &broken, "Late text.", None)
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn a_turn_left_by_a_previous_process_is_interrupted() {
        let (pool, key) = db().await;
        let chat = store::conversation_or_create(&pool, "u", "r")
            .await
            .unwrap();
        let turn = store::create_turn(&pool, &key, &new_turn(&chat.id, "req_1"))
            .await
            .unwrap()
            .unwrap();
        store::save_partial(
            &pool,
            &key,
            &Fence {
                turn_id: &turn.id,
                generation: 0,
                attempt: 1,
                revision: "rv_1",
                lease_owner: "run_1",
            },
            "Text written before the process died.",
            None,
        )
        .await
        .unwrap();
        // Nothing was running, so the partial text is saved directly by the next statement.
        sqlx::query("UPDATE recording_chat_turns SET answer = ? WHERE id = ?")
            .bind(key.encrypt("Text written before the process died."))
            .bind(&turn.id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE recording_chat_turns SET status = 'running' WHERE id = ?")
            .bind(&turn.id)
            .execute(&pool)
            .await
            .unwrap();

        assert_eq!(store::interrupt_orphans(&pool, &key).await.unwrap(), 1);
        let read = store::turn(&pool, &key, "u", "r", &turn.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(read.state, TurnState::Interrupted);
        assert_eq!(read.answer, "Text written before the process died.");
        assert_eq!(read.error_code.as_deref(), Some("CHAT_INTERRUPTED"));
    }

    #[tokio::test]
    async fn clearing_removes_the_turns_and_keeps_the_preference() {
        let (pool, key) = db().await;
        let chat = store::conversation_or_create(&pool, "u", "r")
            .await
            .unwrap();
        store::save_preference(
            &pool,
            "u",
            "r",
            &store::Preference {
                provider_id: Some("prov_1".into()),
                provider: Some("OpenAI".into()),
                model: Some("gpt-4.1-mini".into()),
                effort: Some(EffortChoice::Level(Effort::Max)),
            },
        )
        .await
        .unwrap();
        store::create_turn(&pool, &key, &new_turn(&chat.id, "req_1"))
            .await
            .unwrap()
            .unwrap();
        store::clear(&pool, "u", "r").await.unwrap();
        let after = store::conversation(&pool, "u", "r").await.unwrap().unwrap();
        assert_eq!(after.generation, 1);
        assert!(
            store::recent_turns(&pool, &key, &chat.id, None)
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(after.preference.model.as_deref(), Some("gpt-4.1-mini"));
        assert_eq!(
            after.preference.effort,
            Some(EffortChoice::Level(Effort::Max))
        );
    }

    #[tokio::test]
    async fn a_conversation_belongs_to_one_user_and_recording() {
        let (pool, key) = db().await;
        let chat = store::conversation_or_create(&pool, "u", "r")
            .await
            .unwrap();
        let turn = store::create_turn(&pool, &key, &new_turn(&chat.id, "req_1"))
            .await
            .unwrap()
            .unwrap();
        assert!(
            store::turn(&pool, &key, "u2", "r", &turn.id)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            store::turn(&pool, &key, "u", "r2", &turn.id)
                .await
                .unwrap()
                .is_none()
        );
    }
}

// ---- streaming ----

mod streaming {
    use crate::chat::capabilities::Effort;
    use crate::chat::stream::{self, Limits, SseParser};

    fn parser() -> SseParser {
        SseParser::new(Limits::default())
    }

    fn feed(parser: &mut SseParser, text: &str) -> Vec<String> {
        let events = parser.push(text.as_bytes());
        assert!(
            events.is_ok(),
            "the parser accepted the input: {:?}",
            events.err()
        );
        events.unwrap().into_iter().map(|e| e.data).collect()
    }

    #[test]
    fn an_event_split_across_packets_is_read_whole() {
        let mut parser = parser();
        assert!(feed(&mut parser, "data: {\"a\"").is_empty());
        assert!(feed(&mut parser, ":").is_empty());
        let events = feed(&mut parser, "1}\n\n");
        assert_eq!(events, vec!["{\"a\":1}".to_owned()]);
    }

    #[test]
    fn several_events_in_one_packet_are_all_read() {
        let mut parser = parser();
        let events = feed(&mut parser, "data: one\n\ndata: two\n\n");
        assert_eq!(events, vec!["one".to_owned(), "two".to_owned()]);
    }

    #[test]
    fn an_event_without_trailing_blank_line_is_flushed_on_finish() {
        let mut parser = parser();
        parser.push(b"data: last-piece\n").unwrap();
        let events = parser.finish().unwrap();
        assert_eq!(
            events,
            vec![stream::Event {
                data: "last-piece".to_owned()
            }]
        );
    }

    #[test]
    fn a_multiline_data_field_is_joined_with_newlines() {
        let mut parser = parser();
        let events = feed(&mut parser, "data: first\ndata: second\n\n");
        assert_eq!(events, vec!["first\nsecond".to_owned()]);
    }

    #[test]
    fn comments_and_done_markers_are_not_content() {
        let mut parser = parser();
        let events = feed(&mut parser, ": keep-alive\n\ndata: [DONE]\n\n");
        assert_eq!(events, vec!["[DONE]".to_owned()]);
    }

    #[test]
    fn a_utf8_character_split_across_packets_is_kept() {
        let mut parser = parser();
        let text = "data: 你好\n\n";
        let bytes = text.as_bytes();
        let cut = bytes.len() - 4;
        parser.push(&bytes[..cut]).unwrap();
        let events = parser.push(&bytes[cut..]).unwrap();
        assert_eq!(events[0].data, "你好");
    }

    #[test]
    fn a_frame_past_the_limit_is_refused() {
        let limits = Limits {
            frame_bytes: 32,
            ..Limits::default()
        };
        let mut parser = SseParser::new(limits);
        let refused = parser.push(format!("data: {}\n\n", "x".repeat(64)).as_bytes());
        assert!(refused.is_err(), "an oversized frame must not be buffered");
    }

    #[test]
    fn reading_stops_at_the_response_limit() {
        // Each packet is 18 bytes, so the second one goes past a 30-byte response.
        let limits = Limits {
            frame_bytes: 64,
            response_bytes: 30,
            ..Limits::default()
        };
        let mut parser = SseParser::new(limits);
        parser.push(b"data: 1234567890\n\n").unwrap();
        let refused = parser.push(b"data: 1234567890\n\n");
        assert!(refused.is_err(), "the response limit must stop the read");
    }

    #[test]
    fn an_openai_delta_carries_only_its_text() {
        let body = r#"{"choices":[{"delta":{"content":"Hello ","reasoning_content":"thinking"}}]}"#;
        assert_eq!(stream::openai_delta(body).as_deref(), Some("Hello "));
        let none = r#"{"choices":[{"delta":{"reasoning_content":"only thinking"}}]}"#;
        assert_eq!(stream::openai_delta(none), None);
        assert_eq!(stream::openai_delta("[DONE]"), None);
        assert_eq!(stream::openai_delta("not json"), None);
    }

    #[test]
    fn a_gemini_delta_carries_only_its_text() {
        let body = r#"{"candidates":[{"content":{"parts":[{"text":"Hi "},{"text":"there"}]}}]}"#;
        assert_eq!(stream::gemini_delta(body).as_deref(), Some("Hi there"));
        // A thought part is not answer text.
        let thought = r#"{"candidates":[{"content":{"parts":[{"text":"hmm","thought":true}]}}]}"#;
        assert_eq!(stream::gemini_delta(thought), None);
        assert_eq!(stream::gemini_delta("{}"), None);
    }

    #[test]
    fn chunk_parsing_extracts_reasoning_and_finish_reason() {
        let body = r#"{"choices":[{"delta":{"content":"Answer","reasoning_content":"Thinking steps"},"finish_reason":"length"}]}"#;
        let chunk = stream::parse_openai_chunk(body).unwrap();
        assert_eq!(chunk.content.as_deref(), Some("Answer"));
        assert_eq!(chunk.reasoning.as_deref(), Some("Thinking steps"));
        assert_eq!(chunk.finish_reason.as_deref(), Some("length"));
    }

    #[test]
    fn the_effort_parameter_is_sent_only_when_a_level_was_chosen() {
        assert_eq!(
            stream::openai_body_flags(Some(Effort::Max), 1024),
            (Some("max".to_owned()), 1024)
        );
        assert_eq!(stream::openai_body_flags(None, 1024), (None, 1024));
    }
}

// ---- hub ----

mod hub_tests {
    use crate::chat::hub::{self, HubEvent};

    #[tokio::test]
    async fn turn_hub_broadcasts_deltas_in_real_time() {
        let hub = hub::register("turn_test_1");
        let mut rx = hub.subscribe();

        hub.send(HubEvent::Thinking);
        hub.send(HubEvent::Delta("Hello ".to_owned()));
        hub.send(HubEvent::Delta("world!".to_owned()));
        hub.send(HubEvent::Done);

        assert!(matches!(rx.recv().await.unwrap(), HubEvent::Thinking));
        if let HubEvent::Delta(text) = rx.recv().await.unwrap() {
            assert_eq!(text, "Hello ");
        } else {
            panic!("expected Delta");
        }
        if let HubEvent::Delta(text) = rx.recv().await.unwrap() {
            assert_eq!(text, "world!");
        } else {
            panic!("expected Delta");
        }
        assert!(matches!(rx.recv().await.unwrap(), HubEvent::Done));
        assert_eq!(hub.current_answer(), "Hello world!");

        hub::unregister("turn_test_1");
        assert!(hub::get("turn_test_1").is_none());
    }
}

// ---- retrieval ----

mod retrieval {
    use crate::chat::context::{self, Unit, Window};
    use crate::chat::revision::Timing;

    fn window(ordinal: i64, body: &str) -> Window {
        Window {
            ordinal,
            first: ordinal as usize,
            last: ordinal as usize,
            body: body.into(),
        }
    }

    fn transcript() -> Vec<Window> {
        vec![
            window(
                0,
                "We start with the budget review. The budget is ten thousand dollars.",
            ),
            window(
                1,
                "Then we discussed the launch date. It stays on Friday the twelfth.",
            ),
            window(
                2,
                "Finally the hiring plan: two engineers join next quarter.",
            ),
        ]
    }

    fn lines(count: usize, line: impl Fn(usize) -> String) -> Vec<Unit> {
        let text = (0..count).map(line).collect::<Vec<_>>().join("\n");
        context::units(&text, None, Timing::None)
    }

    #[test]
    fn a_question_finds_the_windows_that_hold_its_words() {
        let found = context::search("When is the launch date?", &transcript(), 2);
        assert!(!found.is_empty(), "the launch passage must be found");
        assert_eq!(found[0].window.ordinal, 1);
    }

    #[test]
    fn a_question_about_a_named_topic_finds_it() {
        let found = context::search("What did we say about the hiring plan?", &transcript(), 1);
        assert_eq!(found[0].window.ordinal, 2);
    }

    #[test]
    fn a_chinese_question_finds_a_chinese_passage() {
        let windows = vec![
            window(0, "今天讨论了预算，预算是一万元。"),
            window(1, "下周开始招聘两名工程师。"),
        ];
        let found = context::search("招聘多少人？", &windows, 1);
        assert_eq!(found[0].window.ordinal, 1);
    }

    #[test]
    fn a_question_with_no_matching_words_finds_nothing() {
        let found = context::search("What is the weather in Paris?", &transcript(), 3);
        assert!(found.is_empty(), "nothing in this transcript answers that");
    }

    #[test]
    fn nearby_windows_come_with_a_hit() {
        let found = context::search("launch date", &transcript(), 1);
        let nearest = context::with_neighbours(&found, &transcript(), 1);
        let ordinals: Vec<i64> = nearest.iter().map(|w| w.ordinal).collect();
        assert_eq!(ordinals, vec![0, 1, 2]);
    }

    #[test]
    fn windows_hold_whole_units_without_gaps_or_overlap() {
        let units = lines(200, |i| format!("Line {i}: {}", "word ".repeat(10)));
        let windows = context::windows(&units);
        assert!(windows.len() > 1);
        assert_eq!(windows[0].first, 0);
        assert_eq!(windows.last().unwrap().last, units.len() - 1);
        for pair in windows.windows(2) {
            assert_eq!(pair[1].first, pair[0].last + 1);
        }
        for window in &windows {
            let size: usize = units[window.first..=window.last]
                .iter()
                .map(|u| u.text.chars().count())
                .sum();
            assert!(
                size <= context::TARGET_CHARS,
                "window {} is {size}",
                window.ordinal
            );
        }
    }

    #[test]
    fn a_short_transcript_is_sent_whole() {
        let units = lines(3, |i| format!("Line {i}."));
        let selection = context::select("When is the launch?", &units, 100_000);
        assert!(selection.whole, "a transcript that fits is sent whole");
        assert_eq!(selection.units, units);
    }

    #[test]
    fn a_long_transcript_sends_the_units_a_question_needs() {
        let units = lines(200, |i| {
            if i == 137 {
                format!("Paragraph {i}: we agreed the launch date stays on Friday.")
            } else {
                format!("Paragraph {i} about routine matters and the weekly status.")
            }
        });
        let selection = context::select("launch date", &units, 2_000);
        assert!(!selection.whole);
        assert!(selection.units.len() < units.len());
        let hit = selection
            .units
            .iter()
            .find(|u| u.text.contains("launch date"))
            .expect("the unit that answers is sent");
        assert_eq!(hit.id(), "src_138", "a sent unit keeps the id of its place");
        let ordinals: Vec<i64> = selection.units.iter().map(|u| u.ordinal).collect();
        let mut sorted = ordinals.clone();
        sorted.sort_unstable();
        assert_eq!(ordinals, sorted, "units read in transcript order");
    }

    #[test]
    fn what_is_sent_never_exceeds_the_budget() {
        let units = lines(300, |i| format!("Paragraph {i} ").repeat(12));
        for budget in [500usize, 2_000, 8_000] {
            let selection = context::select("paragraph 42", &units, budget);
            let used = context::rendered_chars(&selection.units);
            assert!(used <= budget, "used {used} of {budget}");
        }
    }
}
