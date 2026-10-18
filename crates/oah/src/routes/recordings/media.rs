//! ffprobe and ffmpeg helpers, plus MD5 for the stored checksum.

use std::path::Path;
use std::process::Stdio;

use serde_json::Value;
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};

pub struct Probe {
    pub duration_ms: i64,
    pub codec: String,
    /// Sample rate and channel count, to tell whether two inputs can be joined without re-encoding.
    pub format: String,
}

/// Reads the first audio stream. `None` when there is no readable audio or no duration.
pub async fn probe(ffprobe: &Path, file: &Path) -> Option<Probe> {
    let out = Command::new(ffprobe)
        .args(["-v", "error", "-select_streams", "a:0", "-show_entries"])
        .arg("stream=codec_name,sample_rate,channels:format=duration")
        .args(["-of", "json"])
        .arg(file)
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let v: Value = serde_json::from_slice(&out.stdout).ok()?;
    let stream = v["streams"].get(0)?;
    let secs: f64 = v["format"]["duration"].as_str()?.parse().ok()?;
    let duration_ms = (secs * 1000.0).round() as i64;
    if duration_ms <= 0 {
        return None;
    }
    Some(Probe {
        duration_ms,
        codec: stream["codec_name"].as_str()?.to_owned(),
        format: format!("{} {}", stream["sample_rate"], stream["channels"]),
    })
}

/// Runs a command with no input or output. True when it exits successfully.
pub async fn run(cmd: &mut Command) -> bool {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .is_ok_and(|s| s.success())
}

/// Converts any audio file to MP3 at `dst`. True on success.
pub async fn to_mp3(ffmpeg: &Path, src: &Path, dst: &Path) -> bool {
    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-v", "error", "-i"])
        .arg(src)
        .args([
            "-map",
            "0:a:0",
            "-codec:a",
            "libmp3lame",
            "-b:a",
            "128k",
            "-f",
            "mp3",
        ])
        .arg(dst);
    run(&mut cmd).await
}

/// Extracts waveform peak amplitudes (normalized 0.0 to 1.0) across `count` buckets from an audio file using ffmpeg.
pub async fn compute_peaks(ffmpeg: &Path, src: &Path, count: usize) -> Option<Vec<f64>> {
    if count == 0 {
        return None;
    }
    let out = Command::new(ffmpeg)
        .args(["-v", "error", "-i"])
        .arg(src)
        .args(["-ac", "1", "-filter:a", "aresample=500", "-f", "s16le", "-"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .await
        .ok()?;

    if !out.status.success() || out.stdout.is_empty() {
        return None;
    }

    let bytes = &out.stdout;
    let sample_count = bytes.len() / 2;
    if sample_count == 0 {
        return None;
    }

    let block = (sample_count / count).max(1);
    let mut raw_peaks = Vec::with_capacity(count);

    for b in 0..count {
        let start = b * block;
        let end = (start + block).min(sample_count);
        let mut max_val = 0i32;
        for i in start..end {
            let idx = i * 2;
            if idx + 1 < bytes.len() {
                let sample = i16::from_le_bytes([bytes[idx], bytes[idx + 1]]) as i32;
                let abs_val = sample.abs();
                if abs_val > max_val {
                    max_val = abs_val;
                }
            }
        }
        raw_peaks.push(max_val);
    }

    let top = *raw_peaks.iter().max().unwrap_or(&0) as f64;
    let peaks: Vec<f64> = raw_peaks
        .into_iter()
        .map(|v| {
            if top > 0.0 {
                ((v as f64 / top) * 1000.0).round() / 1000.0
            } else {
                0.0
            }
        })
        .collect();

    Some(peaks)
}

/// Starts an MP3 conversion whose output is read from stdout. Dropping the child kills it.
pub fn mp3_stream(ffmpeg: &Path, src: &Path) -> std::io::Result<Child> {
    Command::new(ffmpeg)
        .args(["-v", "error", "-i"])
        .arg(src)
        .args([
            "-map",
            "0:a:0",
            "-codec:a",
            "libmp3lame",
            "-b:a",
            "128k",
            "-f",
            "mp3",
            "pipe:1",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
}

/// MD5 of a file, as lowercase hex.
pub async fn file_md5(path: &Path) -> std::io::Result<String> {
    use md5::Digest;
    let mut file = tokio::fs::File::open(path).await?;
    let mut md5 = md5::Md5::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = file.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        md5.update(&buf[..n]);
    }
    Ok(hex::encode(md5.finalize()))
}
