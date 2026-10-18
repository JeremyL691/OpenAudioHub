//! Silero VAD v5 in-process with ONNX Runtime (spec section 8).

use std::sync::OnceLock;

use ort::environment::Environment;
use ort::{inputs, session::Session, value::Tensor};

const MODEL: &[u8] = include_bytes!("../../models/silero_vad.onnx");
const FRAME: usize = 512;
/// Samples of context kept in front of each frame.
const CTX: usize = 64;
const ROW: usize = CTX + FRAME;
const STATE: usize = 128;
/// Frames per block; the spec checkpoints after each block.
const BLOCK: usize = 1024;
/// floor(300 s / 32 ms): smallest section.
const MIN_SECTION_FRAMES: usize = 300 * 16_000 / FRAME;
const MAX_SECTIONS: usize = 16;
/// Magic, total samples (u64), sections, section length, next block (u32 each).
const CHECKPOINT_MAGIC: &[u8; 8] = b"OAHVADK1";
const CHECKPOINT_HEADER: usize = 8 + 8 + 4 + 4 + 4;

static ENV: OnceLock<Result<Environment, String>> = OnceLock::new();

fn environment() -> Result<&'static Environment, String> {
    ENV.get_or_init(|| {
        ort::init()
            .with_name("oah-pipeline")
            .build()
            .map_err(|e| e.to_string())
    })
    .as_ref()
    .map_err(Clone::clone)
}

/// Loads the bundled model with one intra-op thread.
pub fn load() -> Result<Session, String> {
    let builder = Session::builder(environment()?).map_err(|e| e.to_string())?;
    let mut builder = builder.with_intra_threads(1).map_err(|e| e.to_string())?;
    builder.commit_from_memory(MODEL).map_err(|e| e.to_string())
}

/// How the frames are split. Depends only on the sample count, so a checkpoint made for the
/// same audio always lines up.
struct Layout {
    total_frames: usize,
    bounds: Vec<(usize, usize)>,
    section_len: usize,
    blocks: usize,
}

impl Layout {
    fn new(total_samples: usize) -> Layout {
        let total_frames = total_samples.div_ceil(FRAME);
        let sections = (total_frames / MIN_SECTION_FRAMES).clamp(1, MAX_SECTIONS);
        let per = total_frames.div_ceil(sections);
        let bounds: Vec<(usize, usize)> = (0..sections)
            .map(|s| {
                (
                    (s * per).min(total_frames),
                    ((s + 1) * per).min(total_frames),
                )
            })
            .collect();
        let section_len = bounds.iter().map(|(a, b)| b - a).max().unwrap_or(0);
        Layout {
            total_frames,
            bounds,
            section_len,
            blocks: section_len.div_ceil(BLOCK),
        }
    }
}

/// Saved between blocks: enough to continue a run exactly where it stopped.
#[derive(Debug, Clone, PartialEq)]
pub struct Checkpoint {
    /// The next block to compute.
    pub next_block: usize,
    /// Model state of every section: 2 x sections x STATE values.
    pub state: Vec<f32>,
    /// The 64 samples before the next block, per section.
    pub carry: Vec<Vec<f32>>,
    /// Probability bytes for all frames. Frames at or after `next_block` are still zero.
    pub probs: Vec<u8>,
}

impl Checkpoint {
    fn fresh(layout: &Layout) -> Checkpoint {
        let sections = layout.bounds.len();
        Checkpoint {
            next_block: 0,
            state: vec![0f32; 2 * sections * STATE],
            carry: vec![vec![0f32; CTX]; sections],
            probs: vec![0u8; layout.total_frames],
        }
    }
}

/// True when the checkpoint has the shapes this audio's layout requires.
fn fits(cp: &Checkpoint, layout: &Layout) -> bool {
    let sections = layout.bounds.len();
    cp.next_block <= layout.blocks
        && cp.state.len() == 2 * sections * STATE
        && cp.carry.len() == sections
        && cp.carry.iter().all(|c| c.len() == CTX)
        && cp.probs.len() == layout.total_frames
}

/// Serializes a checkpoint for `total_samples` of audio.
pub fn encode_checkpoint(total_samples: usize, cp: &Checkpoint) -> Vec<u8> {
    let layout = Layout::new(total_samples);
    let floats = cp.state.len() + cp.carry.iter().map(Vec::len).sum::<usize>();
    let mut out = Vec::with_capacity(CHECKPOINT_HEADER + floats * 4 + cp.probs.len());
    out.extend_from_slice(CHECKPOINT_MAGIC);
    out.extend_from_slice(&(total_samples as u64).to_le_bytes());
    out.extend_from_slice(&(cp.carry.len() as u32).to_le_bytes());
    out.extend_from_slice(&(layout.section_len as u32).to_le_bytes());
    out.extend_from_slice(&(cp.next_block as u32).to_le_bytes());
    for v in &cp.state {
        out.extend_from_slice(&v.to_le_bytes());
    }
    for v in cp.carry.iter().flatten() {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out.extend_from_slice(&cp.probs);
    out
}

/// Reads a checkpoint written for `total_samples` of audio. `None` when it is damaged or
/// was made for other audio, so the run starts from block 0.
pub fn decode_checkpoint(bytes: &[u8], total_samples: usize) -> Option<Checkpoint> {
    let layout = Layout::new(total_samples);
    let header = bytes.get(..CHECKPOINT_HEADER)?;
    if &header[..8] != CHECKPOINT_MAGIC {
        return None;
    }
    let samples = u64::from_le_bytes(header[8..16].try_into().ok()?);
    let sections = u32::from_le_bytes(header[16..20].try_into().ok()?) as usize;
    let section_len = u32::from_le_bytes(header[20..24].try_into().ok()?) as usize;
    let next_block = u32::from_le_bytes(header[24..28].try_into().ok()?) as usize;
    if samples != total_samples as u64
        || sections != layout.bounds.len()
        || section_len != layout.section_len
    {
        return None;
    }
    let float_count = 2 * sections * STATE + sections * CTX;
    let body = &bytes[CHECKPOINT_HEADER..];
    if body.len() != float_count * 4 + layout.total_frames {
        return None;
    }
    let (floats, probs) = body.split_at(float_count * 4);
    let mut values = floats
        .as_chunks::<4>()
        .0
        .iter()
        .map(|b| f32::from_le_bytes(*b));
    let state: Vec<f32> = values.by_ref().take(2 * sections * STATE).collect();
    let carry: Vec<Vec<f32>> = (0..sections)
        .map(|_| values.by_ref().take(CTX).collect())
        .collect();
    let cp = Checkpoint {
        next_block,
        state,
        carry,
        probs: probs.to_vec(),
    };
    fits(&cp, &layout).then_some(cp)
}

/// Speech probability per 512-sample frame, quantized to bytes as `round(p * 255)`.
///
/// `resume` continues an earlier run from its saved block; a checkpoint that does not fit
/// the audio is ignored. `read(start, count)` returns `count` samples from `start` as f32
/// in [-1, 1), zero past the end. `progress(fraction, checkpoint)` is called after each block
/// with the state to save; returning false stops the run and gives `Ok(None)`.
pub fn speech_probs(
    session: &mut Session,
    total_samples: usize,
    resume: Option<Checkpoint>,
    mut read: impl FnMut(usize, usize) -> Result<Vec<f32>, String>,
    mut progress: impl FnMut(f64, &Checkpoint) -> bool,
) -> Result<Option<Vec<u8>>, String> {
    let layout = Layout::new(total_samples);
    if layout.total_frames == 0 {
        return Ok(Some(Vec::new()));
    }
    let sections = layout.bounds.len();
    let mut cp = match resume {
        Some(saved) if fits(&saved, &layout) => saved,
        _ => Checkpoint::fresh(&layout),
    };
    let mut inp = vec![0f32; sections * ROW];

    for blk in cp.next_block..layout.blocks {
        let bs = blk * BLOCK;
        // Per section: the 64 samples before the block, then the block's samples (zero padded).
        let mut bufs: Vec<Vec<f32>> = Vec::with_capacity(sections);
        for (bi, &(a, b)) in layout.bounds.iter().enumerate() {
            let first = a + bs;
            let frames = b.saturating_sub(first).min(BLOCK);
            let mut buf = Vec::with_capacity(CTX + BLOCK * FRAME);
            buf.extend_from_slice(&cp.carry[bi]);
            if frames > 0 {
                buf.extend(read(first * FRAME, frames * FRAME)?);
            }
            buf.resize(CTX + BLOCK * FRAME, 0.0);
            cp.carry[bi] = buf[buf.len() - CTX..].to_vec();
            bufs.push(buf);
        }

        for j in 0..BLOCK {
            let t = bs + j;
            if t >= layout.section_len {
                break;
            }
            for (bi, buf) in bufs.iter().enumerate() {
                inp[bi * ROW..(bi + 1) * ROW].copy_from_slice(&buf[j * FRAME..j * FRAME + ROW]);
            }
            let input_t = Tensor::from_array(([sections as i64, ROW as i64], inp.clone()))
                .map_err(|e| e.to_string())?;
            let state_t =
                Tensor::from_array(([2i64, sections as i64, STATE as i64], cp.state.clone()))
                    .map_err(|e| e.to_string())?;
            let sr_t =
                Tensor::from_array(([0i64; 0], vec![16_000i64])).map_err(|e| e.to_string())?;
            let outputs = session
                .run(inputs!["input" => input_t, "state" => state_t, "sr" => sr_t])
                .map_err(|e| e.to_string())?;
            let (_, p) = outputs["output"]
                .try_extract_tensor::<f32>()
                .map_err(|e| e.to_string())?;
            let p = p.to_vec();
            let (_, s) = outputs["stateN"]
                .try_extract_tensor::<f32>()
                .map_err(|e| e.to_string())?;
            cp.state.copy_from_slice(s);
            for (bi, &(a, b)) in layout.bounds.iter().enumerate() {
                if a + t < b {
                    cp.probs[a + t] =
                        ((p[bi] as f64) * 255.0 + 0.5).floor().clamp(0.0, 255.0) as u8;
                }
            }
        }
        cp.next_block = blk + 1;
        let fraction = cp.next_block as f64 / layout.blocks as f64;
        if !progress(fraction, &cp) {
            return Ok(None);
        }
    }
    Ok(Some(cp.probs))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic test signal, zero past its end.
    fn signal(samples: usize) -> Vec<f32> {
        (0..samples)
            .map(|i| ((i as f32) * 0.37).sin() * 0.5 * ((i / 4000) % 3) as f32)
            .collect()
    }

    fn reader(samples: &[f32]) -> impl FnMut(usize, usize) -> Result<Vec<f32>, String> + '_ {
        move |start, count| {
            Ok((0..count)
                .map(|i| samples.get(start + i).copied().unwrap_or(0.0))
                .collect())
        }
    }

    #[test]
    fn model_loads() {
        assert!(load().is_ok());
    }

    #[test]
    fn checkpoint_round_trip_and_mismatch() {
        // 2058 frames: one section, three blocks.
        let samples = 512 * 2058;
        let layout = Layout::new(samples);
        let mut cp = Checkpoint::fresh(&layout);
        cp.next_block = 1;
        cp.state[3] = 0.25;
        cp.carry[0][5] = -0.5;
        cp.probs[7] = 200;
        let bytes = encode_checkpoint(samples, &cp);
        assert_eq!(decode_checkpoint(&bytes, samples), Some(cp));
        // Other audio length, other section count, damaged body, and bad magic all start over.
        assert_eq!(decode_checkpoint(&bytes, 512 * 2059), None);
        assert_eq!(decode_checkpoint(&bytes, 512 * 20_000), None);
        assert_eq!(decode_checkpoint(&bytes[..bytes.len() - 1], samples), None);
        let mut bad = bytes.clone();
        bad[0] = b'X';
        assert_eq!(decode_checkpoint(&bad, samples), None);
        assert_eq!(decode_checkpoint(&[], samples), None);
    }

    #[test]
    fn resumed_run_matches_uninterrupted_run() {
        let samples = 512 * 2058;
        let audio = signal(samples);
        let mut session = load().unwrap();
        let full = speech_probs(&mut session, samples, None, reader(&audio), |_, _| true)
            .unwrap()
            .unwrap();

        // Stop after the first block, keeping the checkpoint it saved.
        let mut saved = None;
        let stopped = speech_probs(&mut session, samples, None, reader(&audio), |_, cp| {
            saved = Some(cp.clone());
            false
        })
        .unwrap();
        assert!(stopped.is_none());
        let saved = saved.expect("a checkpoint after the first block");
        assert_eq!(saved.next_block, 1);
        let bytes = encode_checkpoint(samples, &saved);

        // Resume from the bytes on disk: the first read is block 1, not block 0.
        let resumed_from = decode_checkpoint(&bytes, samples);
        let mut first_read = None;
        let resumed = speech_probs(
            &mut session,
            samples,
            resumed_from,
            |start, count| {
                first_read.get_or_insert(start);
                reader(&audio)(start, count)
            },
            |_, _| true,
        )
        .unwrap()
        .unwrap();
        assert_eq!(first_read, Some(BLOCK * FRAME));
        assert_eq!(resumed, full);
    }
}
