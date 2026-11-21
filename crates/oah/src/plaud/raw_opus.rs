//! Detection, lossless RFC 7845 Ogg/Opus wrapping, and startup self-healing for
//! headerless constant-frame-size raw Opus streams returned by Plaud 4.0 `AUDIO` objects.

use std::fs::File;
use std::io::{self, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use md5::Digest as _;
use serde_json::Value;
use sha2::Sha256;

use crate::AppState;
use crate::db::now_ms;
use crate::ids;
use crate::routes::recordings::media;
use crate::routes::settings;

/// Minimum number of consecutive Opus frames required before treating a headerless file as raw Opus.
const MIN_FRAMES: u64 = 5;
/// Maximum trailing all-zero padding (one 512-byte flash sector) tolerated at the end of a raw stream.
const MAX_ZERO_TAIL_PAD: u64 = 512;
const MONO_STRIDES: [usize; 5] = [40, 60, 80, 120, 160];
const STEREO_STRIDES: [usize; 5] = [80, 120, 160, 240, 320];

const OGG_CRC_TABLE: [u32; 256] = {
    let mut table = [0u32; 256];
    let mut i = 0;
    while i < 256 {
        let mut r = (i as u32) << 24;
        let mut bit = 0;
        while bit < 8 {
            if (r & 0x8000_0000) != 0 {
                r = (r << 1) ^ 0x04C1_1DB7;
            } else {
                r <<= 1;
            }
            bit += 1;
        }
        table[i] = r;
        i += 1;
    }
    table
};

/// Parameters of a headerless constant-frame-size raw Opus stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RawOpusSpec {
    pub frame_size: usize,
    pub frame_count: u64,
    pub toc: u8,
    pub channels: u8,
    pub samples_per_frame: u32,
    pub input_sample_rate: u32,
}

/// True when `head` begins with a recognized audio or container signature.
pub fn is_known_container(head: &[u8]) -> bool {
    head.starts_with(b"ID3")
        || (head.len() >= 2 && head[0] == 0xFF && head[1] & 0xE0 == 0xE0)
        || head.starts_with(b"OggS")
        || (head.len() >= 12 && &head[0..4] == b"RIFF" && &head[8..12] == b"WAVE")
        || (head.len() >= 8 && &head[4..8] == b"ftyp")
        || head.starts_with(&[0x1A, 0x45, 0xDF, 0xA3])
        || head.starts_with(b"fLaC")
        || head.starts_with(b"caff")
        || head.starts_with(b"ADIF")
        || head.starts_with(b"#!AMR")
}

/// Parses an RFC 6716 single-frame Opus packet header `(b0, b1)` into
/// `(channels, samples_per_frame_48k, input_sample_rate)`.
/// Accepts standard single-frame packets (`code == 0`, rejecting `0x00` as an all-zero guard) and
/// CBR single-frame packets using `code == 3` padding (`b1` has `v=0, M=1`, such as `0x41`), which
/// Opus encoders emit when padding low-entropy frames to the constant CBR packet size.
fn parse_single_frame_header(b0: u8, b1: u8) -> Option<(u8, u32, u32)> {
    let valid_single = match b0 & 0x03 {
        0 => b0 != 0x00,
        3 => b1 == 0x41 || b1 == 0x01,
        _ => false,
    };
    if !valid_single {
        return None;
    }
    let cfg = b0 >> 3;
    let channels = if (b0 & 0x04) != 0 { 2 } else { 1 };
    let samples_per_frame = match cfg {
        0..=11 => match cfg % 4 {
            0 => 480,
            1 => 960,
            2 => 1920,
            _ => 2880,
        },
        12..=15 => match cfg % 2 {
            0 => 480,
            _ => 960,
        },
        16..=31 => match cfg % 4 {
            0 => 120,
            1 => 240,
            2 => 480,
            _ => 960,
        },
        _ => return None,
    };
    let input_sample_rate = match cfg {
        0..=3 | 16..=19 => 8_000,
        4..=7 => 12_000,
        8..=11 | 20..=23 => 16_000,
        12..=13 | 24..=27 => 24_000,
        _ => 48_000,
    };
    Some((channels, samples_per_frame, input_sample_rate))
}

/// Detects a headerless constant-frame-size raw Opus stream on disk.
/// Reads only sampled frame boundaries so even multi-hour files inspect in under a millisecond.
pub fn detect_file(path: &Path) -> io::Result<Option<RawOpusSpec>> {
    let mut file = File::open(path)?;
    let file_len = file.metadata()?.len();
    if file_len < MIN_FRAMES * 40 {
        return Ok(None);
    }

    let mut head = [0u8; 64];
    let head_len = file.read(&mut head)?;
    let head = &head[..head_len];
    if head.len() < 2 || is_known_container(head) {
        return Ok(None);
    }

    let toc = head[0];
    let Some((channels, samples_per_frame, input_sample_rate)) =
        parse_single_frame_header(head[0], head[1])
    else {
        return Ok(None);
    };

    // Read up to 1024 trailing bytes once so candidate strides can inspect tail padding without re-reading.
    let tail_len = file_len.min(1024) as usize;
    let tail_start = file_len - tail_len as u64;
    let mut tail = vec![0u8; tail_len];
    file.seek(SeekFrom::Start(tail_start))?;
    file.read_exact(&mut tail)?;

    // Test candidate strides in ascending order so a smaller frame size is never aliased by its multiple.
    let strides = if channels == 2 {
        &STEREO_STRIDES
    } else {
        &MONO_STRIDES
    };

    for &stride in strides {
        let Some(frame_count) =
            usable_frames(file_len, stride as u64, &tail, channels, samples_per_frame)
        else {
            continue;
        };
        if frame_count < MIN_FRAMES {
            continue;
        }
        if let Some(detected_rate) = matches_stride(
            &mut file,
            frame_count,
            stride,
            toc,
            channels,
            samples_per_frame,
        )? {
            return Ok(Some(RawOpusSpec {
                frame_size: stride,
                frame_count,
                toc,
                channels,
                samples_per_frame,
                input_sample_rate: input_sample_rate.max(detected_rate),
            }));
        }
    }

    Ok(None)
}

/// Computes the number of usable `stride`-byte frames after tolerating up to `MAX_ZERO_TAIL_PAD`
/// trailing zero bytes. Returns `None` if trailing bytes past a frame boundary are non-zero.
fn usable_frames(
    file_len: u64,
    stride: u64,
    tail: &[u8],
    channels: u8,
    samples_per_frame: u32,
) -> Option<u64> {
    let rem = file_len % stride;
    if rem > MAX_ZERO_TAIL_PAD {
        return None;
    }
    let tail_start = file_len - tail.len() as u64;
    if rem > 0 {
        let rem_slice = &tail[tail.len() - rem as usize..];
        if rem_slice.iter().any(|&b| b != 0) {
            return None;
        }
    }

    let mut usable_bytes = file_len - rem;
    // Also strip trailing all-zero full frames if they fall within the 512-byte flash sector padding cap.
    while usable_bytes >= stride && (file_len - (usable_bytes - stride)) <= MAX_ZERO_TAIL_PAD {
        let frame_start = usable_bytes - stride;
        if frame_start < tail_start {
            break;
        }
        let rel = (frame_start - tail_start) as usize;
        let frame = &tail[rel..rel + stride as usize];
        if frame.iter().all(|&b| b == 0) {
            usable_bytes -= stride;
        } else {
            // Confirm the last non-zero frame starts with a compatible Opus packet header.
            let compatible = parse_single_frame_header(frame[0], frame[1])
                .is_some_and(|(ch, spf, _)| ch == channels && spf == samples_per_frame);
            if !compatible {
                return None;
            }
            break;
        }
    }

    Some(usable_bytes / stride)
}

fn matches_stride(
    file: &mut File,
    frame_count: u64,
    stride: usize,
    toc: u8,
    channels: u8,
    samples_per_frame: u32,
) -> io::Result<Option<u32>> {
    // Guard against constant-byte fill files (for example every byte equal to `toc`).
    let check_frames = frame_count.min(8) as usize;
    let mut prefix = vec![0u8; check_frames * stride];
    file.seek(SeekFrom::Start(0))?;
    file.read_exact(&mut prefix)?;
    if prefix.iter().all(|&b| b == toc) {
        return Ok(None);
    }

    let mut indices = Vec::with_capacity(140);
    for i in 0..frame_count.min(64) {
        indices.push(i);
    }
    let end_start = frame_count.saturating_sub(8);
    for i in end_start..frame_count {
        indices.push(i);
    }
    if frame_count > 64 {
        for step in 0..64u64 {
            indices.push((step * (frame_count - 1)) / 63);
        }
    }
    indices.sort_unstable();
    indices.dedup();

    let mut seen_tocs = [false; 256];
    let mut distinct_tocs = 0usize;
    let mut max_rate = 0u32;
    let mut hdr = [0u8; 2];
    for &idx in &indices {
        file.seek(SeekFrom::Start(idx * stride as u64))?;
        file.read_exact(&mut hdr)?;
        let Some((ch, spf, sr)) = parse_single_frame_header(hdr[0], hdr[1]) else {
            return Ok(None);
        };
        if ch != channels || spf != samples_per_frame {
            return Ok(None);
        }
        if !seen_tocs[usize::from(hdr[0])] {
            seen_tocs[usize::from(hdr[0])] = true;
            distinct_tocs += 1;
        }
        if sr > max_rate {
            max_rate = sr;
        }
    }

    // For tiny files (<12 frames), cap TOC variety so random bytes cannot satisfy multiple configs.
    // For longer files, all >=12..=133 sampled boundaries must match (channels, single-frame, duration),
    // allowing Opus encoders to switch bandwidth or emit CBR-padded code-3 single frames across packets.
    if frame_count < 12 && distinct_tocs > 2 {
        return Ok(None);
    }
    Ok(Some(max_rate))
}

/// SHA-256 over the exact `spec.frame_count * spec.frame_size` raw Opus packet bytes.
fn hash_raw_opus_packets(path: &Path, spec: RawOpusSpec) -> io::Result<[u8; 32]> {
    let mut reader = BufReader::with_capacity(64 * 1024, File::open(path)?);
    let mut hasher = Sha256::new();
    let mut remaining = spec.frame_count.saturating_mul(spec.frame_size as u64);
    let mut buf = [0u8; 64 * 1024];
    while remaining > 0 {
        let want = remaining.min(buf.len() as u64) as usize;
        reader.read_exact(&mut buf[..want])?;
        hasher.update(&buf[..want]);
        remaining -= want as u64;
    }
    Ok(hasher.finalize().into())
}

/// SHA-256 over the concatenated audio packet payloads inside an Ogg/Opus file, skipping
/// `OpusHead` and `OpusTags`. Matches `hash_raw_opus_packets` when the Ogg wraps those frames losslessly.
fn hash_ogg_opus_packets(path: &Path) -> io::Result<Option<[u8; 32]>> {
    let mut reader = BufReader::with_capacity(64 * 1024, File::open(path)?);
    let mut hasher = Sha256::new();
    let mut hdr = [0u8; 27];
    let mut lacing = [0u8; 255];
    let mut seg_buf = [0u8; 255];
    let mut current_pkt = Vec::new();
    let mut packet_idx = 0u64;
    let mut audio_packets = 0u64;

    loop {
        let mut filled = 0;
        while filled < hdr.len() {
            let n = reader.read(&mut hdr[filled..])?;
            if n == 0 {
                if filled == 0 {
                    return Ok(
                        (packet_idx >= 3 && audio_packets > 0 && current_pkt.is_empty())
                            .then(|| hasher.finalize().into()),
                    );
                }
                return Ok(None);
            }
            filled += n;
        }
        if &hdr[0..4] != b"OggS" {
            return Ok(None);
        }
        let nseg = usize::from(hdr[26]);
        reader.read_exact(&mut lacing[..nseg])?;
        for &seg_len_u8 in &lacing[..nseg] {
            let seg_len = usize::from(seg_len_u8);
            if seg_len > 0 {
                reader.read_exact(&mut seg_buf[..seg_len])?;
                current_pkt.extend_from_slice(&seg_buf[..seg_len]);
            }
            if seg_len < 255 {
                match packet_idx {
                    0 => {
                        if !current_pkt.starts_with(b"OpusHead") {
                            return Ok(None);
                        }
                    }
                    1 => {
                        if !current_pkt.starts_with(b"OpusTags") {
                            return Ok(None);
                        }
                    }
                    _ => {
                        hasher.update(&current_pkt);
                        audio_packets += 1;
                    }
                }
                packet_idx += 1;
                current_pkt.clear();
            }
        }
    }
}

/// True when `raw_path` is a headerless raw Opus stream whose packet stream hash matches `expected`.
fn raw_file_matches_packet_hash(raw_path: &Path, expected: &[u8; 32]) -> io::Result<bool> {
    let Some(spec) = detect_file(raw_path)? else {
        return Ok(false);
    };
    let actual = hash_raw_opus_packets(raw_path, spec)?;
    Ok(&actual == expected)
}

fn ogg_crc(data: &[u8]) -> u32 {
    let mut crc = 0u32;
    for &b in data {
        crc = (crc << 8) ^ OGG_CRC_TABLE[((crc >> 24) ^ u32::from(b)) as usize];
    }
    crc
}

struct HashingWriter<W> {
    inner: W,
    hasher: md5::Md5,
    written: i64,
}

impl<W: Write> HashingWriter<W> {
    fn new(inner: W) -> Self {
        Self {
            inner,
            hasher: md5::Md5::new(),
            written: 0,
        }
    }
}

impl<W: Write> Write for HashingWriter<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let n = self.inner.write(buf)?;
        self.hasher.update(&buf[..n]);
        self.written = self
            .written
            .saturating_add(i64::try_from(n).unwrap_or(i64::MAX));
        Ok(n)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

fn write_ogg_page<W: Write>(
    writer: &mut W,
    page_buf: &mut Vec<u8>,
    header_type: u8,
    granule: u64,
    serial: u32,
    seq: u32,
    packets: &[&[u8]],
) -> io::Result<()> {
    page_buf.clear();
    let mut seg_count = 0usize;
    let mut body_len = 0usize;
    for pkt in packets {
        seg_count += (pkt.len() / 255) + 1;
        body_len += pkt.len();
    }
    debug_assert!(seg_count <= 255);
    page_buf.reserve(27 + seg_count + body_len);

    page_buf.extend_from_slice(b"OggS");
    page_buf.push(0); // stream structure version
    page_buf.push(header_type);
    page_buf.extend_from_slice(&granule.to_le_bytes());
    page_buf.extend_from_slice(&serial.to_le_bytes());
    page_buf.extend_from_slice(&seq.to_le_bytes());
    page_buf.extend_from_slice(&0u32.to_le_bytes()); // CRC placeholder
    page_buf.push(seg_count as u8);

    for pkt in packets {
        let mut rem = pkt.len();
        while rem >= 255 {
            page_buf.push(255);
            rem -= 255;
        }
        page_buf.push(rem as u8);
    }
    for pkt in packets {
        page_buf.extend_from_slice(pkt);
    }

    let crc = ogg_crc(page_buf);
    page_buf[22..26].copy_from_slice(&crc.to_le_bytes());
    writer.write_all(page_buf)
}

/// Losslessly wraps a raw Opus stream into a standard RFC 7845 Ogg/Opus file.
/// Streams frame-by-frame in constant memory and returns `(byte_len, md5_hex)`.
pub fn mux_to_ogg(src: &Path, dst: &Path, spec: RawOpusSpec) -> io::Result<(i64, String)> {
    const SERIAL: u32 = 1;
    let mut reader = BufReader::with_capacity(64 * 1024, File::open(src)?);
    let out_file = File::create(dst)?;
    let mut writer = HashingWriter::new(BufWriter::with_capacity(64 * 1024, out_file));
    let mut page_buf = Vec::with_capacity(16 * 1024);

    // Page 0 (BOS): RFC 7845 OpusHead (19 bytes, channel mapping family 0).
    let mut opus_head = Vec::with_capacity(19);
    opus_head.extend_from_slice(b"OpusHead");
    opus_head.push(1); // version
    opus_head.push(spec.channels);
    opus_head.extend_from_slice(&0u16.to_le_bytes()); // pre_skip
    opus_head.extend_from_slice(&spec.input_sample_rate.to_le_bytes());
    opus_head.extend_from_slice(&0i16.to_le_bytes()); // output gain
    opus_head.push(0); // channel mapping family
    write_ogg_page(
        &mut writer,
        &mut page_buf,
        0x02,
        0,
        SERIAL,
        0,
        &[&opus_head],
    )?;

    // Page 1: RFC 7845 OpusTags.
    let vendor = b"OpenAudioHub";
    let mut opus_tags = Vec::with_capacity(16 + vendor.len());
    opus_tags.extend_from_slice(b"OpusTags");
    opus_tags.extend_from_slice(&(vendor.len() as u32).to_le_bytes());
    opus_tags.extend_from_slice(vendor);
    opus_tags.extend_from_slice(&0u32.to_le_bytes()); // 0 comments
    write_ogg_page(
        &mut writer,
        &mut page_buf,
        0x00,
        0,
        SERIAL,
        1,
        &[&opus_tags],
    )?;

    // Audio pages: ~1 second per page (up to 50 frames) while staying within the 255-segment Ogg limit.
    let segs_per_packet = (spec.frame_size / 255) + 1;
    let packets_per_page = (255 / segs_per_packet).clamp(1, 50);
    let mut chunk_buf = vec![0u8; packets_per_page * spec.frame_size];

    let mut remaining = spec.frame_count;
    let mut granule = 0u64;
    let mut seq = 2u32;
    while remaining > 0 {
        let take = remaining.min(packets_per_page as u64) as usize;
        let bytes = take * spec.frame_size;
        reader.read_exact(&mut chunk_buf[..bytes])?;
        let packet_refs: Vec<&[u8]> = chunk_buf[..bytes].chunks_exact(spec.frame_size).collect();
        remaining -= take as u64;
        granule = granule.saturating_add(take as u64 * u64::from(spec.samples_per_frame));
        let header_type = if remaining == 0 { 0x04 } else { 0x00 };
        write_ogg_page(
            &mut writer,
            &mut page_buf,
            header_type,
            granule,
            SERIAL,
            seq,
            &packet_refs,
        )?;
        seq = seq.wrapping_add(1);
    }

    writer.flush()?;
    let byte_len = writer.written;
    let file_md5 = hex::encode(writer.hasher.finalize());
    let file = writer.inner.into_inner().map_err(|e| e.into_error())?;
    file.sync_all()?;
    Ok((byte_len, file_md5))
}

/// Wraps `src` into `dst` as Ogg/Opus when `src` is a headerless raw Opus stream and `ffprobe`
/// confirms the wrapped stream is readable. Removes `dst` if it is not raw Opus or fails probe.
pub async fn wrap_if_raw_opus(
    ffprobe: &Path,
    src: &Path,
    dst: &Path,
) -> io::Result<Option<(i64, String)>> {
    let src_owned = src.to_path_buf();
    let Some(spec) = tokio::task::spawn_blocking(move || detect_file(&src_owned))
        .await
        .map_err(io::Error::other)??
    else {
        return Ok(None);
    };

    let src_owned = src.to_path_buf();
    let dst_owned = dst.to_path_buf();
    let (byte_len, file_md5) =
        tokio::task::spawn_blocking(move || mux_to_ogg(&src_owned, &dst_owned, spec))
            .await
            .map_err(io::Error::other)??;

    if media::probe(ffprobe, dst).await.is_none() {
        let _ = tokio::fs::remove_file(dst).await;
        return Ok(None);
    }
    Ok(Some((byte_len, file_md5)))
}

/// Repairs already-synced local `.mp3` recordings whose bytes are headerless raw Opus streams,
/// replacing them losslessly with `.ogg` containers and healing matching broken desktop auto-exports.
pub async fn repair_stored_raw_opus(state: &AppState) {
    let rows: Vec<(String, String, String, String)> = match sqlx::query_as(
        "SELECT id, user_id, storage_type, storage_path FROM recordings \
         WHERE deleted_at IS NULL AND storage_type IN ('local', 'local_folder') \
         AND lower(storage_path) LIKE '%.mp3'",
    )
    .fetch_all(&state.db)
    .await
    {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(error = %e, "could not query recordings for raw Opus repair");
            return;
        }
    };

    for (id, user_id, storage_type, storage_path) in rows {
        if let Err(e) =
            repair_one_recording(state, &id, &user_id, &storage_type, &storage_path).await
        {
            tracing::warn!(recording = %id, error = %e, "raw Opus repair failed for recording");
        }
    }

    // Second pass: heal any desktop auto-export or unfinished `.mp3` export reservation left
    // behind after a crash between updating `storage_path` and repairing the export state.
    let exported_rows: Vec<(String, String, String, String)> = match sqlx::query_as(
        "SELECT id, user_id, storage_type, storage_path FROM recordings \
         WHERE deleted_at IS NULL \
         AND (auto_export_path IS NOT NULL OR auto_export_target IS NOT NULL) \
         AND storage_type IN ('local', 'local_folder') AND lower(storage_path) LIKE '%.ogg'",
    )
    .fetch_all(&state.db)
    .await
    {
        Ok(r) => r,
        Err(_) => return,
    };

    for (id, user_id, storage_type, storage_path) in exported_rows {
        let Ok(Some(repaired_ogg)) = state.storage.local_path(&storage_type, &storage_path) else {
            continue;
        };
        if !tokio::fs::try_exists(&repaired_ogg).await.unwrap_or(false) {
            continue;
        }
        if let Err(e) = repair_auto_export(state, &user_id, &id, &repaired_ogg).await {
            tracing::warn!(recording = %id, error = %e, "raw Opus auto-export repair failed");
        }
        if let Err(e) = repair_auto_export_reservation(state, &user_id, &id, &repaired_ogg).await {
            tracing::warn!(recording = %id, error = %e, "raw Opus export reservation repair failed");
        }
    }
}

async fn repair_one_recording(
    state: &AppState,
    id: &str,
    user_id: &str,
    storage_type: &str,
    storage_path: &str,
) -> Result<(), String> {
    let Ok(Some(old_path)) = state.storage.local_path(storage_type, storage_path) else {
        return Ok(());
    };
    if !tokio::fs::try_exists(&old_path).await.unwrap_or(false) {
        return Ok(());
    }

    let check_path = old_path.clone();
    let spec = tokio::task::spawn_blocking(move || detect_file(&check_path))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    let Some(spec) = spec else {
        return Ok(());
    };

    let parent = old_path
        .parent()
        .ok_or_else(|| "stored file has no parent folder".to_owned())?;
    let stem = old_path
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(id);

    let tmp_path = parent.join(format!(".repair-opus-{}.partial", ids::token_hex(8)));
    let src_owned = old_path.clone();
    let tmp_owned = tmp_path.clone();
    let (byte_len, file_md5) =
        match tokio::task::spawn_blocking(move || mux_to_ogg(&src_owned, &tmp_owned, spec)).await {
            Ok(Ok(meta)) => meta,
            Ok(Err(e)) => {
                let _ = tokio::fs::remove_file(&tmp_path).await;
                return Err(e.to_string());
            }
            Err(e) => {
                let _ = tokio::fs::remove_file(&tmp_path).await;
                return Err(e.to_string());
            }
        };

    if media::probe(&state.config.ffprobe, &tmp_path)
        .await
        .is_none()
    {
        let _ = tokio::fs::remove_file(&tmp_path).await;
        return Err("repaired Ogg/Opus file failed ffprobe verification".into());
    }

    // Hold the folder lock only across the rename + DB commit so `local_folder` cannot import a duplicate.
    let dest_path = {
        let _folder_guard = crate::local_folder::lock().await;

        let (new_storage_path, dest_path) = if storage_type == "local" {
            let new_key = match free_local_ogg_key(state, user_id, stem).await {
                Ok(key) => key,
                Err(e) => {
                    let _ = tokio::fs::remove_file(&tmp_path).await;
                    return Err(e);
                }
            };
            let dest = state.config.storage_root.join(&new_key);
            (new_key, dest)
        } else {
            let dest = unique_ogg_path(parent, stem).await;
            (dest.to_string_lossy().into_owned(), dest)
        };

        if let Err(e) = tokio::fs::rename(&tmp_path, &dest_path).await {
            let _ = tokio::fs::remove_file(&tmp_path).await;
            return Err(format!(
                "could not move repaired Ogg/Opus file into place: {e}"
            ));
        }

        let updated = match sqlx::query(
            "UPDATE recordings SET storage_path = ?, filesize = ?, file_md5 = ?, \
             auto_export_attempts = 0, updated_at = ? \
             WHERE id = ? AND storage_path = ? AND deleted_at IS NULL",
        )
        .bind(&new_storage_path)
        .bind(byte_len)
        .bind(&file_md5)
        .bind(now_ms())
        .bind(id)
        .bind(storage_path)
        .execute(&state.db)
        .await
        {
            Ok(done) => done,
            Err(e) => {
                let _ = tokio::fs::remove_file(&dest_path).await;
                return Err(e.to_string());
            }
        };

        if updated.rows_affected() != 1 {
            let _ = tokio::fs::remove_file(&dest_path).await;
            return Ok(());
        }

        let _ = tokio::fs::remove_file(&old_path).await;
        tracing::info!(
            recording = %id,
            storage_path = %new_storage_path,
            bytes = byte_len,
            "repaired stored raw Opus recording"
        );
        dest_path
    };

    if let Err(e) = repair_auto_export(state, user_id, id, &dest_path).await {
        tracing::warn!(recording = %id, error = %e, "raw Opus auto-export repair failed");
    }
    if let Err(e) = repair_auto_export_reservation(state, user_id, id, &dest_path).await {
        tracing::warn!(recording = %id, error = %e, "raw Opus export reservation repair failed");
    }

    Ok(())
}

/// Repairs a desktop auto-exported `.mp3` only when the file on disk is still the exact raw Opus
/// packet stream of `repaired_ogg`. Stages copy/transcode outside `local_folder::lock()`, then
/// acquires the lock only to re-verify DB state and packet identity, rename, and commit.
async fn repair_auto_export(
    state: &AppState,
    user_id: &str,
    recording_id: &str,
    repaired_ogg: &Path,
) -> Result<(), String> {
    let encrypted_export: Option<String> = sqlx::query_scalar(
        "SELECT auto_export_path FROM recordings WHERE id = ? AND deleted_at IS NULL",
    )
    .bind(recording_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| e.to_string())?
    .flatten();
    let Some(encrypted_export) = encrypted_export else {
        return Ok(());
    };
    let Ok(export_str) = state.config.field_key.decrypt(&encrypted_export) else {
        return Ok(());
    };
    if export_str.is_empty() {
        return Ok(());
    }
    let export_path = PathBuf::from(&export_str);
    let is_mp3 = export_path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("mp3"));
    if !is_mp3 || !tokio::fs::try_exists(&export_path).await.unwrap_or(false) {
        return Ok(());
    }

    // Verify that the exported `.mp3` holds this recording's exact raw Opus packets, not another file.
    let ogg_for_hash = repaired_ogg.to_path_buf();
    let expected_hash = tokio::task::spawn_blocking(move || hash_ogg_opus_packets(&ogg_for_hash))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    let Some(expected_hash) = expected_hash else {
        return Ok(());
    };
    let probe_path = export_path.clone();
    let matches_recording = tokio::task::spawn_blocking(move || {
        raw_file_matches_packet_hash(&probe_path, &expected_hash)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    if !matches_recording {
        return Ok(());
    }

    let Some(folder) = export_path.parent() else {
        return Ok(());
    };
    let Some(stem) = export_path
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
    else {
        return Ok(());
    };

    let format = settings::effective(state, user_id)
        .await
        .ok()
        .and_then(|s| {
            s.get("autoExportFormat")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "mp3".to_owned());

    if format == "original" || format == "ogg" {
        let tmp = folder.join(format!(".repair-export-{}.partial", ids::token_hex(8)));
        if let Err(e) = tokio::fs::copy(repaired_ogg, &tmp).await {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(format!("could not copy repaired Ogg/Opus export: {e}"));
        }

        let _folder_guard = crate::local_folder::lock().await;
        let current_export: Option<String> = match sqlx::query_scalar(
            "SELECT auto_export_path FROM recordings WHERE id = ? AND deleted_at IS NULL",
        )
        .bind(recording_id)
        .fetch_optional(&state.db)
        .await
        {
            Ok(row) => row.flatten(),
            Err(e) => {
                let _ = tokio::fs::remove_file(&tmp).await;
                return Err(e.to_string());
            }
        };
        if current_export.as_deref() != Some(encrypted_export.as_str())
            || !tokio::fs::try_exists(&export_path).await.unwrap_or(false)
        {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Ok(());
        }

        let recheck_path = export_path.clone();
        let still_matches = matches!(
            tokio::task::spawn_blocking(move || {
                raw_file_matches_packet_hash(&recheck_path, &expected_hash)
            })
            .await,
            Ok(Ok(true))
        );
        if !still_matches {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Ok(());
        }

        let dest = unique_ogg_path(folder, stem).await;
        if let Err(e) = tokio::fs::rename(&tmp, &dest).await {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(format!("could not move repaired Ogg/Opus export: {e}"));
        }
        let updated = match sqlx::query(
            "UPDATE recordings SET auto_export_path = ?, updated_at = ? \
             WHERE id = ? AND auto_export_path = ? AND deleted_at IS NULL",
        )
        .bind(state.config.field_key.encrypt(&dest.to_string_lossy()))
        .bind(now_ms())
        .bind(recording_id)
        .bind(&encrypted_export)
        .execute(&state.db)
        .await
        {
            Ok(done) => done,
            Err(e) => {
                let _ = tokio::fs::remove_file(&dest).await;
                return Err(e.to_string());
            }
        };
        if updated.rows_affected() == 1 {
            let _ = tokio::fs::remove_file(&export_path).await;
            tracing::info!(
                recording = %recording_id,
                export_path = %dest.display(),
                "repaired auto-exported raw Opus file as .ogg"
            );
        } else {
            let _ = tokio::fs::remove_file(&dest).await;
        }
    } else {
        let tmp = folder.join(format!(".repair-export-{}.mp3.partial", ids::token_hex(8)));
        if !media::to_mp3(&state.config.ffmpeg, repaired_ogg, &tmp).await {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err("could not transcode repaired Ogg/Opus export to mp3".into());
        }

        let _folder_guard = crate::local_folder::lock().await;
        let current_export: Option<String> = match sqlx::query_scalar(
            "SELECT auto_export_path FROM recordings WHERE id = ? AND deleted_at IS NULL",
        )
        .bind(recording_id)
        .fetch_optional(&state.db)
        .await
        {
            Ok(row) => row.flatten(),
            Err(e) => {
                let _ = tokio::fs::remove_file(&tmp).await;
                return Err(e.to_string());
            }
        };
        if current_export.as_deref() != Some(encrypted_export.as_str())
            || !tokio::fs::try_exists(&export_path).await.unwrap_or(false)
        {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Ok(());
        }

        let recheck_path = export_path.clone();
        let still_matches = matches!(
            tokio::task::spawn_blocking(move || {
                raw_file_matches_packet_hash(&recheck_path, &expected_hash)
            })
            .await,
            Ok(Ok(true))
        );
        if !still_matches {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Ok(());
        }

        if let Err(e) = tokio::fs::rename(&tmp, &export_path).await {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(format!("could not replace repaired mp3 export: {e}"));
        }
        tracing::info!(
            recording = %recording_id,
            export_path = %export_path.display(),
            "repaired auto-exported raw Opus file as valid .mp3"
        );
    }

    Ok(())
}

/// Validates an unfinished `.mp3` `auto_export_target` reservation after the stored recording became `.ogg`.
/// - Missing target under `original`/`ogg`: clears the stale `.mp3` reservation so retry picks `.ogg`.
/// - Existing target matching this recording's raw Opus packets: promotes and repairs it cleanly.
/// - Existing target that does not match this recording under `original`/`ogg`: clears the incompatible
///   reservation so `export_pending` neither adopts nor overwrites an unrelated file.
async fn repair_auto_export_reservation(
    state: &AppState,
    user_id: &str,
    recording_id: &str,
    repaired_ogg: &Path,
) -> Result<(), String> {
    let row: Option<(Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT auto_export_path, auto_export_target FROM recordings WHERE id = ? AND deleted_at IS NULL",
    )
    .bind(recording_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| e.to_string())?;
    let Some((None, Some(encrypted_target))) = row else {
        return Ok(());
    };
    let Ok(target_str) = state.config.field_key.decrypt(&encrypted_target) else {
        return Ok(());
    };
    if target_str.is_empty() {
        return Ok(());
    }
    let target_path = PathBuf::from(&target_str);
    let is_mp3 = target_path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("mp3"));
    if !is_mp3 {
        return Ok(());
    }

    let format = settings::effective(state, user_id)
        .await
        .ok()
        .and_then(|s| {
            s.get("autoExportFormat")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "mp3".to_owned());
    let expects_ogg = format == "original" || format == "ogg";

    if !tokio::fs::try_exists(&target_path).await.unwrap_or(false) {
        if expects_ogg {
            let _folder_guard = crate::local_folder::lock().await;
            let _ = sqlx::query(
                "UPDATE recordings SET auto_export_target = NULL, updated_at = ? \
                 WHERE id = ? AND auto_export_path IS NULL AND auto_export_target = ? AND deleted_at IS NULL",
            )
            .bind(now_ms())
            .bind(recording_id)
            .bind(&encrypted_target)
            .execute(&state.db)
            .await
            .map_err(|e| e.to_string())?;
        }
        return Ok(());
    }

    let ogg_for_hash = repaired_ogg.to_path_buf();
    let expected_hash = tokio::task::spawn_blocking(move || hash_ogg_opus_packets(&ogg_for_hash))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    let matches_recording = match expected_hash {
        Some(expected) => {
            let probe = target_path.clone();
            tokio::task::spawn_blocking(move || raw_file_matches_packet_hash(&probe, &expected))
                .await
                .map_err(|e| e.to_string())?
                .map_err(|e| e.to_string())?
        }
        None => false,
    };

    if matches_recording {
        // An interrupted export left this recording's raw Opus `.mp3` on disk; promote it to
        // `auto_export_path` and run the standard verified export repair.
        let promoted = {
            let _folder_guard = crate::local_folder::lock().await;
            sqlx::query(
                "UPDATE recordings SET auto_export_path = ?, auto_export_target = NULL, \
                 auto_export_attempts = 0, updated_at = ? \
                 WHERE id = ? AND auto_export_path IS NULL AND auto_export_target = ? AND deleted_at IS NULL",
            )
            .bind(&encrypted_target)
            .bind(now_ms())
            .bind(recording_id)
            .bind(&encrypted_target)
            .execute(&state.db)
            .await
            .map_err(|e| e.to_string())?
        };
        if promoted.rows_affected() == 1 {
            repair_auto_export(state, user_id, recording_id, repaired_ogg).await?;
        }
    } else if expects_ogg {
        let _folder_guard = crate::local_folder::lock().await;
        let _ = sqlx::query(
            "UPDATE recordings SET auto_export_target = NULL, updated_at = ? \
             WHERE id = ? AND auto_export_path IS NULL AND auto_export_target = ? AND deleted_at IS NULL",
        )
        .bind(now_ms())
        .bind(recording_id)
        .bind(&encrypted_target)
        .execute(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    }

    Ok(())
}

async fn free_local_ogg_key(state: &AppState, user_id: &str, stem: &str) -> Result<String, String> {
    for n in 1..=100usize {
        let name = if n == 1 {
            format!("{stem}.ogg")
        } else {
            format!("{stem} ({n}).ogg")
        };
        let key = format!("{user_id}/{name}");
        let taken: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM recordings WHERE storage_path = ?")
                .bind(&key)
                .fetch_one(&state.db)
                .await
                .map_err(|e| e.to_string())?;
        let on_disk = tokio::fs::try_exists(state.config.storage_root.join(&key))
            .await
            .unwrap_or(true);
        if taken == 0 && !on_disk {
            return Ok(key);
        }
    }
    Err("no free file name for repaired Ogg/Opus recording".into())
}

async fn unique_ogg_path(folder: &Path, stem: &str) -> PathBuf {
    let mut n = 1usize;
    loop {
        let name = if n == 1 {
            format!("{stem}.ogg")
        } else {
            format!("{stem} ({n}).ogg")
        };
        let candidate = folder.join(name);
        if !tokio::fs::try_exists(&candidate).await.unwrap_or(false) {
            return candidate;
        }
        n += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn raw_opus_bytes(toc: u8, frame_size: usize, frames: usize) -> Vec<u8> {
        let mut out = Vec::with_capacity(frame_size * frames);
        for _ in 0..frames {
            out.push(toc);
            out.push(0xFF);
            out.push(0xFE);
            out.resize(out.len() + frame_size - 3, 0);
        }
        out
    }

    #[tokio::test]
    async fn detects_and_muxes_mono_80b_and_stereo_160b_raw_opus() {
        let dir = tempfile::tempdir().unwrap();
        let config = crate::Config::for_tests(dir.path());

        // Mono CELT WB 20ms (TOC 0xB8, 80 bytes/frame, 150 frames = 3.0s)
        let mono_src = dir.path().join("mono.raw");
        let mono_dst = dir.path().join("mono.ogg");
        std::fs::write(&mono_src, raw_opus_bytes(0xB8, 80, 150)).unwrap();

        let spec = detect_file(&mono_src).unwrap().expect("mono raw opus");
        assert_eq!(spec.frame_size, 80);
        assert_eq!(spec.frame_count, 150);
        assert_eq!(spec.channels, 1);
        assert_eq!(spec.samples_per_frame, 960);
        assert_eq!(spec.input_sample_rate, 16_000);

        let (len, md5) = wrap_if_raw_opus(&config.ffprobe, &mono_src, &mono_dst)
            .await
            .unwrap()
            .expect("wrapped mono");
        assert!(len > 12_000);
        assert_eq!(md5.len(), 32);
        let probe = media::probe(&config.ffprobe, &mono_dst)
            .await
            .expect("ffprobe mono ogg");
        assert_eq!(probe.codec, "opus");
        assert_eq!(probe.duration_ms, 3_000);
        assert_eq!(probe.format, "\"48000\" 1");

        // Stereo CELT WB 20ms (TOC 0xBC, 160 bytes/frame, 50 frames = 1.0s)
        let stereo_src = dir.path().join("stereo.raw");
        let stereo_dst = dir.path().join("stereo.ogg");
        std::fs::write(&stereo_src, raw_opus_bytes(0xBC, 160, 50)).unwrap();

        let stereo_spec = detect_file(&stereo_src).unwrap().expect("stereo raw opus");
        assert_eq!(stereo_spec.frame_size, 160);
        assert_eq!(stereo_spec.frame_count, 50);
        assert_eq!(stereo_spec.channels, 2);

        wrap_if_raw_opus(&config.ffprobe, &stereo_src, &stereo_dst)
            .await
            .unwrap()
            .expect("wrapped stereo");
        let stereo_probe = media::probe(&config.ffprobe, &stereo_dst)
            .await
            .expect("ffprobe stereo ogg");
        assert_eq!(stereo_probe.codec, "opus");
        assert_eq!(stereo_probe.duration_ms, 1_000);
        assert_eq!(stereo_probe.format, "\"48000\" 2");
    }

    #[test]
    fn trims_trailing_zero_sector_padding_and_prefers_smallest_stride() {
        let dir = tempfile::tempdir().unwrap();

        // 20 frames of 80 bytes + 32 trailing zero padding bytes
        let mut padded = raw_opus_bytes(0xB8, 80, 20);
        padded.extend(std::iter::repeat_n(0u8, 32));
        let padded_path = dir.path().join("padded.raw");
        std::fs::write(&padded_path, &padded).unwrap();
        let spec = detect_file(&padded_path).unwrap().expect("padded raw opus");
        assert_eq!(spec.frame_size, 80);
        assert_eq!(spec.frame_count, 20);

        // 40-byte mono frames must be detected as stride=40, not aliased as stride=80.
        let small = raw_opus_bytes(0xB8, 40, 20);
        let small_path = dir.path().join("small40.raw");
        std::fs::write(&small_path, &small).unwrap();
        let small_spec = detect_file(&small_path).unwrap().expect("40B raw opus");
        assert_eq!(small_spec.frame_size, 40);
        assert_eq!(small_spec.frame_count, 20);
    }

    #[test]
    fn rejects_containers_random_bytes_uniform_fill_and_nonzero_tails() {
        let dir = tempfile::tempdir().unwrap();

        let cases: [(&str, Vec<u8>); 7] = [
            (
                "id3.mp3",
                [b"ID3\x04\0\0\0\0\0\0".as_slice(), &vec![0u8; 800]].concat(),
            ),
            (
                "mpeg.mp3",
                [b"\xFF\xFB\x90\x00".as_slice(), &vec![0u8; 800]].concat(),
            ),
            (
                "ogg.ogg",
                [b"OggS\0\x02".as_slice(), &vec![0u8; 800]].concat(),
            ),
            ("zeros.bin", vec![0u8; 800]),
            ("uniform_b8.bin", vec![0xB8u8; 800]),
            ("too_short.bin", raw_opus_bytes(0xB8, 80, 4)),
            ("garbage_tail.bin", {
                let mut v = raw_opus_bytes(0xB8, 80, 10);
                v.extend_from_slice(&[0x12, 0x34, 0x56]);
                v
            }),
        ];
        for (name, bytes) in cases {
            let p = dir.path().join(name);
            std::fs::write(&p, bytes).unwrap();
            assert!(
                detect_file(&p).unwrap().is_none(),
                "expected rejection for {name}"
            );
        }
    }

    #[tokio::test]
    async fn startup_repair_heals_local_raw_opus_and_auto_exports_while_leaving_real_mp3_alone() {
        let dir = tempfile::tempdir().unwrap();
        let export_dir = dir.path().join("exports");
        tokio::fs::create_dir_all(&export_dir).await.unwrap();
        let mut config = crate::Config::for_tests(dir.path());
        config.storage_root = dir.path().join("storage");
        tokio::fs::create_dir_all(config.storage_root.join("u1"))
            .await
            .unwrap();
        let state = AppState::new(config, crate::db::open_memory().await.unwrap());
        let now = now_ms();

        sqlx::query("INSERT INTO users (id, email, created_at, updated_at) VALUES ('u1', 'u1@example.test', ?, ?)")
            .bind(now)
            .bind(now)
            .execute(&state.db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO user_settings (user_id, data, updated_at) VALUES ('u1', ?, ?)")
            .bind(json!({ "autoExport": true, "autoExportFormat": "original" }).to_string())
            .bind(now)
            .execute(&state.db)
            .await
            .unwrap();

        let raw = raw_opus_bytes(0xB8, 80, 50);
        let broken_storage = state.config.storage_root.join("u1/f_raw1.mp3");
        let broken_export = export_dir.join("2026-11-20.mp3");
        tokio::fs::write(&broken_storage, &raw).await.unwrap();
        tokio::fs::write(&broken_export, &raw).await.unwrap();

        let valid_mp3 = state.config.storage_root.join("u1/f_real.mp3");
        tokio::fs::write(
            &valid_mp3,
            [b"ID3\x04".as_slice(), &vec![0u8; 800]].concat(),
        )
        .await
        .unwrap();

        sqlx::query(
            "INSERT INTO recordings (id, user_id, device_sn, plaud_file_id, filename, duration, start_time, end_time, \
             filesize, file_md5, storage_type, storage_path, auto_export_path, auto_export_attempts, plaud_version, is_trash, created_at, updated_at, title_source) \
             VALUES ('r_raw', 'u1', '', 'f_raw1', ?, 1000, ?, ?, ?, 'oldmd5', 'local', 'u1/f_raw1.mp3', ?, 3, '1', 0, ?, ?, 'date')",
        )
        .bind(state.config.field_key.encrypt("2026-11-20"))
        .bind(now)
        .bind(now + 1000)
        .bind(raw.len() as i64)
        .bind(state.config.field_key.encrypt(&broken_export.to_string_lossy()))
        .bind(now)
        .bind(now)
        .execute(&state.db)
        .await
        .unwrap();

        sqlx::query(
            "INSERT INTO recordings (id, user_id, device_sn, plaud_file_id, filename, duration, start_time, end_time, \
             filesize, file_md5, storage_type, storage_path, plaud_version, is_trash, created_at, updated_at, title_source) \
             VALUES ('r_real', 'u1', '', 'f_real', ?, 1000, ?, ?, 804, 'realmd5', 'local', 'u1/f_real.mp3', '1', 0, ?, ?, 'date')",
        )
        .bind(state.config.field_key.encrypt("Real"))
        .bind(now)
        .bind(now + 1000)
        .bind(now)
        .bind(now)
        .execute(&state.db)
        .await
        .unwrap();

        repair_stored_raw_opus(&state).await;

        let (sp, sz, md5, enc_exp, attempts): (String, i64, String, Option<String>, i64) = sqlx::query_as(
            "SELECT storage_path, filesize, file_md5, auto_export_path, auto_export_attempts FROM recordings WHERE id = 'r_raw'",
        )
        .fetch_one(&state.db)
        .await
        .unwrap();
        assert_eq!(sp, "u1/f_raw1.ogg");
        assert!(sz > raw.len() as i64);
        assert_ne!(md5, "oldmd5");
        assert_eq!(attempts, 0);
        assert!(!broken_storage.exists());
        let repaired_storage = state.config.storage_root.join(&sp);
        assert!(repaired_storage.exists());
        let probe = media::probe(&state.config.ffprobe, &repaired_storage)
            .await
            .expect("repaired storage plays");
        assert_eq!(probe.codec, "opus");
        assert_eq!(probe.duration_ms, 1_000);

        let dec_exp = state
            .config
            .field_key
            .decrypt(&enc_exp.expect("export path kept"))
            .unwrap();
        assert!(dec_exp.ends_with("2026-11-20.ogg"), "{dec_exp}");
        assert!(!broken_export.exists());
        assert!(Path::new(&dec_exp).exists());
        assert!(
            media::probe(&state.config.ffprobe, Path::new(&dec_exp))
                .await
                .is_some()
        );

        // Real MP3 row and file are untouched.
        let real_sp: String =
            sqlx::query_scalar("SELECT storage_path FROM recordings WHERE id = 'r_real'")
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert_eq!(real_sp, "u1/f_real.mp3");
        assert!(valid_mp3.exists());
    }

    #[tokio::test]
    async fn startup_repair_transcodes_raw_opus_export_when_mp3_format_is_chosen() {
        let dir = tempfile::tempdir().unwrap();
        let export_dir = dir.path().join("exports");
        tokio::fs::create_dir_all(&export_dir).await.unwrap();
        let mut config = crate::Config::for_tests(dir.path());
        config.storage_root = dir.path().join("storage");
        tokio::fs::create_dir_all(config.storage_root.join("u1"))
            .await
            .unwrap();
        let state = AppState::new(config, crate::db::open_memory().await.unwrap());
        let now = now_ms();

        sqlx::query("INSERT INTO users (id, email, created_at, updated_at) VALUES ('u1', 'u1@example.test', ?, ?)")
            .bind(now)
            .bind(now)
            .execute(&state.db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO user_settings (user_id, data, updated_at) VALUES ('u1', ?, ?)")
            .bind(json!({ "autoExport": true, "autoExportFormat": "mp3" }).to_string())
            .bind(now)
            .execute(&state.db)
            .await
            .unwrap();

        let raw = raw_opus_bytes(0xB8, 80, 50);
        let broken_storage = state.config.storage_root.join("u1/f_raw_mp3.mp3");
        let broken_export = export_dir.join("2026-11-20.mp3");
        tokio::fs::write(&broken_storage, &raw).await.unwrap();
        tokio::fs::write(&broken_export, &raw).await.unwrap();

        sqlx::query(
            "INSERT INTO recordings (id, user_id, device_sn, plaud_file_id, filename, duration, start_time, end_time, \
             filesize, file_md5, storage_type, storage_path, auto_export_path, plaud_version, is_trash, created_at, updated_at, title_source) \
             VALUES ('r_mp3', 'u1', '', 'f_raw_mp3', ?, 1000, ?, ?, ?, 'oldmd5', 'local', 'u1/f_raw_mp3.mp3', ?, '1', 0, ?, ?, 'date')",
        )
        .bind(state.config.field_key.encrypt("2026-11-20"))
        .bind(now)
        .bind(now + 1000)
        .bind(raw.len() as i64)
        .bind(state.config.field_key.encrypt(&broken_export.to_string_lossy()))
        .bind(now)
        .bind(now)
        .execute(&state.db)
        .await
        .unwrap();

        repair_stored_raw_opus(&state).await;

        assert!(broken_export.exists());
        assert!(detect_file(&broken_export).unwrap().is_none());
        let probe = media::probe(&state.config.ffprobe, &broken_export)
            .await
            .expect("repaired mp3 export plays");
        assert_eq!(probe.codec, "mp3");
        assert!(probe.duration_ms >= 900);
    }

    #[tokio::test]
    async fn detects_variable_bandwidth_cbr_opus_and_real_libopus_stream() {
        let dir = tempfile::tempdir().unwrap();
        let config = crate::Config::for_tests(dir.path());

        // Mixed-bandwidth 80-byte mono 20ms CBR frames: 9x 0xF8 (FB), 123x 0xB8 (WB), 1x 0xD8 (SWB).
        let mut mixed = Vec::new();
        for (toc, count) in [(0xF8u8, 9usize), (0xB8, 123), (0xD8, 1)] {
            mixed.extend(raw_opus_bytes(toc, 80, count));
        }
        let mixed_src = dir.path().join("mixed_bw.raw");
        let mixed_dst = dir.path().join("mixed_bw.ogg");
        std::fs::write(&mixed_src, &mixed).unwrap();
        let spec = detect_file(&mixed_src)
            .unwrap()
            .expect("mixed bandwidth raw opus");
        assert_eq!(spec.frame_size, 80);
        assert_eq!(spec.frame_count, 133);
        assert_eq!(spec.input_sample_rate, 48_000);
        wrap_if_raw_opus(&config.ffprobe, &mixed_src, &mixed_dst)
            .await
            .unwrap()
            .expect("wrapped mixed bandwidth");
        let probe = media::probe(&config.ffprobe, &mixed_dst)
            .await
            .expect("probe mixed bandwidth");
        assert_eq!(probe.codec, "opus");
        assert_eq!(probe.duration_ms, 2_660);

        // Real libopus CBR 32 kbps mono 20ms encoded audio extracted from Ogg into a headerless stream.
        let encoded_ogg = dir.path().join("encoded.ogg");
        let mut cmd = tokio::process::Command::new(&config.ffmpeg);
        cmd.args([
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000:duration=2",
            "-ac",
            "1",
            "-c:a",
            "libopus",
            "-vbr",
            "off",
            "-b:a",
            "32k",
            "-frame_duration",
            "20",
            "-f",
            "ogg",
        ])
        .arg(&encoded_ogg);
        assert!(media::run(&mut cmd).await, "ffmpeg libopus encode");

        // Extract raw 80-byte Opus audio packets from the Ogg container.
        let ogg_bytes = std::fs::read(&encoded_ogg).unwrap();
        let mut raw_packets = Vec::new();
        let mut pos = 0usize;
        let mut cur = Vec::new();
        while pos + 27 <= ogg_bytes.len() && &ogg_bytes[pos..pos + 4] == b"OggS" {
            let nseg = usize::from(ogg_bytes[pos + 26]);
            let lacing = &ogg_bytes[pos + 27..pos + 27 + nseg];
            let mut body_pos = pos + 27 + nseg;
            for &seg in lacing {
                let len = usize::from(seg);
                cur.extend_from_slice(&ogg_bytes[body_pos..body_pos + len]);
                body_pos += len;
                if len < 255 {
                    if !cur.starts_with(b"OpusHead") && !cur.starts_with(b"OpusTags") {
                        assert_eq!(cur.len(), 80);
                        raw_packets.extend_from_slice(&cur);
                    }
                    cur.clear();
                }
            }
            pos = body_pos;
        }
        assert!(raw_packets.len() >= 80 * 50);

        let real_raw = dir.path().join("real_libopus.raw");
        let real_rewrapped = dir.path().join("real_libopus.ogg");
        std::fs::write(&real_raw, &raw_packets).unwrap();
        let real_spec = detect_file(&real_raw)
            .unwrap()
            .expect("real libopus CBR raw stream");
        assert_eq!(real_spec.frame_size, 80);
        wrap_if_raw_opus(&config.ffprobe, &real_raw, &real_rewrapped)
            .await
            .unwrap()
            .expect("rewrapped real libopus");
        let real_probe = media::probe(&config.ffprobe, &real_rewrapped)
            .await
            .expect("probe rewrapped real libopus");
        assert_eq!(real_probe.codec, "opus");
        assert!(real_probe.duration_ms >= 1_900);
        assert_eq!(
            hash_ogg_opus_packets(&real_rewrapped).unwrap(),
            Some(hash_raw_opus_packets(&real_raw, real_spec).unwrap())
        );
    }

    #[tokio::test]
    async fn startup_repair_leaves_unrelated_raw_opus_export_alone_and_clears_stale_mp3_reservation()
     {
        let dir = tempfile::tempdir().unwrap();
        let export_dir = dir.path().join("exports");
        tokio::fs::create_dir_all(&export_dir).await.unwrap();
        let mut config = crate::Config::for_tests(dir.path());
        config.storage_root = dir.path().join("storage");
        tokio::fs::create_dir_all(config.storage_root.join("u1"))
            .await
            .unwrap();
        let state = AppState::new(config, crate::db::open_memory().await.unwrap());
        let now = now_ms();

        sqlx::query("INSERT INTO users (id, email, created_at, updated_at) VALUES ('u1', 'u1@example.test', ?, ?)")
            .bind(now)
            .bind(now)
            .execute(&state.db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO user_settings (user_id, data, updated_at) VALUES ('u1', ?, ?)")
            .bind(json!({ "autoExport": true, "autoExportFormat": "original" }).to_string())
            .bind(now)
            .execute(&state.db)
            .await
            .unwrap();

        let rec_a_raw = raw_opus_bytes(0xB8, 80, 50);
        // Different raw Opus recording B sitting at recording A's export path.
        let mut rec_b_raw = raw_opus_bytes(0xB8, 80, 50);
        rec_b_raw[10] = 0xAA;

        let storage_a = state.config.storage_root.join("u1/f_rec_a.mp3");
        let export_b_at_a = export_dir.join("2026-11-20.mp3");
        tokio::fs::write(&storage_a, &rec_a_raw).await.unwrap();
        tokio::fs::write(&export_b_at_a, &rec_b_raw).await.unwrap();

        sqlx::query(
            "INSERT INTO recordings (id, user_id, device_sn, plaud_file_id, filename, duration, start_time, end_time, \
             filesize, file_md5, storage_type, storage_path, auto_export_path, plaud_version, is_trash, created_at, updated_at, title_source) \
             VALUES ('r_a', 'u1', '', 'f_rec_a', ?, 1000, ?, ?, ?, 'oldmd5', 'local', 'u1/f_rec_a.mp3', ?, '1', 0, ?, ?, 'date')",
        )
        .bind(state.config.field_key.encrypt("2026-11-20"))
        .bind(now)
        .bind(now + 1000)
        .bind(rec_a_raw.len() as i64)
        .bind(state.config.field_key.encrypt(&export_b_at_a.to_string_lossy()))
        .bind(now)
        .bind(now)
        .execute(&state.db)
        .await
        .unwrap();

        // Recording C failed export with a missing `.mp3` reservation.
        let storage_c = state.config.storage_root.join("u1/f_rec_c.mp3");
        let stale_target = export_dir.join("Meeting.mp3");
        tokio::fs::write(&storage_c, &rec_a_raw).await.unwrap();
        sqlx::query(
            "INSERT INTO recordings (id, user_id, device_sn, plaud_file_id, filename, duration, start_time, end_time, \
             filesize, file_md5, storage_type, storage_path, auto_export_path, auto_export_target, auto_export_attempts, plaud_version, is_trash, created_at, updated_at, title_source) \
             VALUES ('r_c', 'u1', '', 'f_rec_c', ?, 1000, ?, ?, ?, 'oldmd5', 'local', 'u1/f_rec_c.mp3', NULL, ?, 3, '1', 0, ?, ?, 'original')",
        )
        .bind(state.config.field_key.encrypt("Meeting"))
        .bind(now)
        .bind(now + 1000)
        .bind(rec_a_raw.len() as i64)
        .bind(state.config.field_key.encrypt(&stale_target.to_string_lossy()))
        .bind(now)
        .bind(now)
        .execute(&state.db)
        .await
        .unwrap();

        repair_stored_raw_opus(&state).await;

        // Recording B occupying A's export path must remain completely untouched.
        assert_eq!(tokio::fs::read(&export_b_at_a).await.unwrap(), rec_b_raw);
        assert!(!export_dir.join("2026-11-20.ogg").exists());

        // Recording C's stale `.mp3` reservation is cleared and attempts reset to 0.
        let (sp_c, target_c, attempts_c): (String, Option<String>, i64) = sqlx::query_as(
            "SELECT storage_path, auto_export_target, auto_export_attempts FROM recordings WHERE id = 'r_c'",
        )
        .fetch_one(&state.db)
        .await
        .unwrap();
        assert_eq!(sp_c, "u1/f_rec_c.ogg");
        assert!(target_c.is_none());
        assert_eq!(attempts_c, 0);
    }
}
