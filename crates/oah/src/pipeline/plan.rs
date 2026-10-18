//! Speech spans from VAD probabilities, and the cut of speech into chunks (spec sections 8 and 9).
//! All positions are 16 kHz sample indexes.

const FRAME: u64 = 512;
/// Speech spans closer than this (1.5 s) belong to one run.
const GAP: u64 = 24_000;
/// Timestamp guard (50 ms) added after the last span of a run.
const GUARD: u64 = 800;
/// Target chunk length (120 s).
const TARGET: u64 = 1_920_000;
/// Hard limit per chunk (170 s), also the provider limit.
pub const MAX_CHUNK: u64 = 2_720_000;
/// Lower cut limit (78 s, 65% of the target).
const LOWER: u64 = 1_248_000;

// Byte thresholds from round(p * 255), and frame counts from the spec (32 ms frames).
const THRESHOLD: u8 = 128;
const NEG_THRESHOLD: u8 = 89;
const MIN_SPEECH_FRAMES: usize = 4;
const MIN_SILENCE_FRAMES: usize = 13;
const PAD: u64 = 4_000; // 250 ms

/// Speech spans `(start, end)` in samples, from per-frame probabilities.
pub fn speech_spans(probs: &[u8], total_samples: u64) -> Vec<(u64, u64)> {
    let mut raw: Vec<(usize, usize)> = Vec::new();
    let mut triggered = false;
    let mut start = 0usize;
    let mut temp_end: Option<usize> = None;
    for (i, &v) in probs.iter().enumerate() {
        if v >= THRESHOLD {
            if !triggered {
                triggered = true;
                start = i;
            }
            temp_end = None;
        } else if triggered && v < NEG_THRESHOLD {
            let te = *temp_end.get_or_insert(i);
            if i - te >= MIN_SILENCE_FRAMES {
                if te - start >= MIN_SPEECH_FRAMES {
                    raw.push((start, te));
                }
                triggered = false;
                temp_end = None;
            }
        }
    }
    if triggered {
        let end = temp_end.unwrap_or(probs.len());
        if end - start >= MIN_SPEECH_FRAMES {
            raw.push((start, end));
        }
    }

    let mut out: Vec<(u64, u64)> = Vec::new();
    for (f0, f1) in raw {
        let s = (f0 as u64 * FRAME).saturating_sub(PAD);
        let e = (f1 as u64 * FRAME + PAD).min(total_samples);
        match out.last_mut() {
            Some(last) if s <= last.1 => last.1 = last.1.max(e),
            _ => out.push((s, e)),
        }
    }
    out.retain(|(s, e)| e > s);
    out
}

/// Chunk cuts `(start, end)` over the speech spans. Chunks are adjacent inside a run
/// and never cross a run boundary, so long silences are left out.
pub fn plan_chunks(spans: &[(u64, u64)], probs: &[u8], total_samples: u64) -> Vec<(u64, u64)> {
    // Runs as (start, end, first span index, last span index).
    let mut groups: Vec<(usize, usize)> = Vec::new();
    for i in 0..spans.len() {
        match groups.last_mut() {
            Some(g) if spans[i].0.saturating_sub(spans[i - 1].1) <= GAP => g.1 = i,
            _ => groups.push((i, i)),
        }
    }
    let mut out = Vec::new();
    for (k, &(a, b)) in groups.iter().enumerate() {
        let limit = match groups.get(k + 1) {
            Some(&(next, _)) => spans[next].0,
            None => total_samples,
        };
        let run_start = spans[a].0;
        let run_end = (spans[b].1 + GUARD).min(limit);
        let run_spans = &spans[a..=b];
        let mut cursor = run_start;
        while cursor < run_end {
            if run_end - cursor <= MAX_CHUNK {
                out.push((cursor, run_end));
                break;
            }
            let lower = cursor + LOWER;
            let upper = (cursor + MAX_CHUNK).min(run_end);
            let cut = best_pause(run_spans, lower, upper, cursor + TARGET)
                .or_else(|| quietest(probs, cursor + TARGET, upper))
                .unwrap_or(upper);
            // Step 5 of the spec: never stall or go backwards.
            let cut = if cut <= cursor {
                run_end.min(cursor + MAX_CHUNK)
            } else {
                cut
            };
            out.push((cursor, cut));
            cursor = cut;
        }
    }
    out
}

/// Longest gap whose next span starts in `[lower, upper]`; ties go to the cut nearest `target`, then the earlier one.
fn best_pause(spans: &[(u64, u64)], lower: u64, upper: u64, target: u64) -> Option<u64> {
    spans
        .windows(2)
        .map(|w| (w[1].0.saturating_sub(w[0].1), w[1].0))
        .filter(|&(_, cut)| cut >= lower && cut <= upper)
        .min_by_key(|&(gap, cut)| (std::cmp::Reverse(gap), cut.abs_diff(target), cut))
        .map(|(_, cut)| cut)
}

/// Cut just after the quietest frame in `[lo, hi]` (first one on a tie). None without probabilities.
fn quietest(probs: &[u8], lo: u64, hi: u64) -> Option<u64> {
    let first = (lo / FRAME) as usize;
    let last = ((hi / FRAME) as usize).min(probs.len().checked_sub(1)?);
    if first > last {
        return None;
    }
    let mut best = first;
    for f in first..=last {
        if probs[f] < probs[best] {
            best = f;
        }
    }
    Some(((best as u64 + 1) * FRAME).clamp(lo, hi))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probs(parts: &[(usize, u8)]) -> Vec<u8> {
        parts
            .iter()
            .flat_map(|&(n, v)| std::iter::repeat_n(v, n))
            .collect()
    }

    #[test]
    fn one_span_is_padded_and_clamped() {
        let p = probs(&[(100, 200), (100, 0)]);
        let spans = speech_spans(&p, 200 * 512);
        assert_eq!(spans, vec![(0, 100 * 512 + PAD)]);
    }

    #[test]
    fn short_blip_is_dropped() {
        assert!(speech_spans(&probs(&[(2, 255), (30, 0)]), 32 * 512).is_empty());
    }

    #[test]
    fn short_run_is_one_chunk_with_guard() {
        let spans = vec![(16_000, 48_000), (60_000, 80_000)];
        assert_eq!(
            plan_chunks(&spans, &[], 1_000_000),
            vec![(16_000, 80_000 + GUARD)]
        );
    }

    #[test]
    fn long_speech_is_cut_adjacent_and_within_limits() {
        let total = 6_400_000;
        let spans = vec![(0, total)];
        let chunks = plan_chunks(&spans, &[], total);
        assert_eq!(chunks.first().map(|c| c.0), Some(0));
        assert_eq!(chunks.last().map(|c| c.1), Some(total));
        for w in chunks.windows(2) {
            assert_eq!(w[0].1, w[1].0);
        }
        assert!(chunks.iter().all(|c| c.1 - c.0 <= MAX_CHUNK));
    }

    #[test]
    fn long_pause_is_preferred_as_cut() {
        // A 1 s pause (inside a run) at 2.0 M samples, inside the 78 s to 170 s window.
        let spans = vec![(0, 2_000_000), (2_016_000, 6_400_000)];
        let chunks = plan_chunks(&spans, &[], 6_400_000);
        assert_eq!(chunks[0], (0, 2_016_000));
    }

    #[test]
    fn runs_are_separated_by_long_silence() {
        let spans = vec![(0, 100_000), (1_000_000, 1_100_000)];
        let chunks = plan_chunks(&spans, &[], 2_000_000);
        assert_eq!(
            chunks,
            vec![(0, 100_000 + GUARD), (1_000_000, 1_100_000 + GUARD)]
        );
    }
}
