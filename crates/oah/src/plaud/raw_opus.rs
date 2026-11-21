//! Detection, lossless RFC 7845 Ogg/Opus wrapping, and startup self-healing for
//! headerless constant-frame-size raw Opus streams returned by Plaud 4.0 `AUDIO` objects.

use std::fs::File;
use std::io::{self, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use md5::Digest;
use serde_json::Value;

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

/// Parses an RFC 6716 single-frame Opus TOC byte into `(channels, samples_per_frame_48k, input_sample_rate)`.
/// Rejects `0x00` (all-zero guard) and multi-frame packets (`code != 0`).
fn parse_single_frame_toc(toc: u8) -> Option<(u8, u32, u32)> {
    if toc == 0x00 || (toc & 0x03) != 0 {
        return None;
    }
    let cfg = toc >> 3;
    let channels = if (toc & 0x04) != 0 { 2 } else { 1 };
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
    if head.is_empty() || is_known_container(head) {
        return Ok(None);
    }

    let toc = head[0];
    let Some((channels, samples_per_frame, input_sample_rate)) = parse_single_frame_toc(toc) else {
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
            usable_frames(file_len, stride as u64, &tail, toc, samples_per_frame)
        else {
            continue;
        };
        if frame_count < MIN_FRAMES {
            continue;
        }
        if matches_stride(&mut file, frame_count, stride, toc, samples_per_frame)? {
            return Ok(Some(RawOpusSpec {
                frame_size: stride,
                frame_count,
                toc,
                channels,
                samples_per_frame,
                input_sample_rate,
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
    toc: u8,
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
            // Confirm the last non-zero frame starts with a compatible TOC byte.
            let b = frame[0];
            let compatible = (b & 0x07) == (toc & 0x07)
                && parse_single_frame_toc(b).is_some_and(|(_, spf, _)| spf == samples_per_frame);
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
    samples_per_frame: u32,
) -> io::Result<bool> {
    // Guard against constant-byte fill files (for example every byte equal to `toc`).
    let check_frames = frame_count.min(8) as usize;
    let mut prefix = vec![0u8; check_frames * stride];
    file.seek(SeekFrom::Start(0))?;
    file.read_exact(&mut prefix)?;
    if prefix.iter().all(|&b| b == toc) {
        return Ok(false);
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

    let mut exact = 0usize;
    let mut byte = [0u8; 1];
    for &idx in &indices {
        file.seek(SeekFrom::Start(idx * stride as u64))?;
        file.read_exact(&mut byte)?;
        let b = byte[0];
        if (b & 0x07) != (toc & 0x07) {
            return Ok(false);
        }
        let Some((_, spf, _)) = parse_single_frame_toc(b) else {
            return Ok(false);
        };
        if spf != samples_per_frame {
            return Ok(false);
        }
        if b == toc {
            exact += 1;
        }
    }

    if frame_count < 32 {
        Ok(exact == indices.len())
    } else {
        Ok(exact * 100 >= indices.len() * 95)
    }
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

    // Second pass: heal any desktop auto-export that remained a raw Opus `.mp3` after a previous
    // crash between updating `storage_path` and repairing `auto_export_path`.
    let exported_rows: Vec<(String, String, String, String)> = match sqlx::query_as(
        "SELECT id, user_id, storage_type, storage_path FROM recordings \
         WHERE deleted_at IS NULL AND auto_export_path IS NOT NULL \
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

    Ok(())
}

/// Repairs a desktop auto-exported `.mp3` when the exported file is still raw Plaud Opus bytes.
/// Stages any copy or MP3 transcode outside `local_folder::lock()`, then acquires the lock only
/// to re-verify state, rename into place, and commit the DB path.
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

    // Only touch the exported file if its bytes are still raw Plaud Opus; a file the user replaced stays untouched.
    let probe_path = export_path.clone();
    let is_raw = tokio::task::spawn_blocking(move || detect_file(&probe_path))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?
        .is_some();
    if !is_raw {
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
        let still_raw = matches!(
            tokio::task::spawn_blocking(move || detect_file(&recheck_path)).await,
            Ok(Ok(Some(_)))
        );
        if !still_raw {
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
}
