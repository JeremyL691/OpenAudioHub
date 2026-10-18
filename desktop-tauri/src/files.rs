//! The data folder and the files in it (spec/desktop.md sections 2 and 3).

use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

/// `~/Library/Application Support/OpenAudioHub` on macOS, `%LOCALAPPDATA%\OpenAudioHub` on Windows.
/// `OAH_DESKTOP_DATA_DIR` overrides it (development and tests must never touch real data).
pub fn data_dir() -> PathBuf {
    // OAH_USER_DATA_DIR is accepted as an alias.
    // An empty value is ignored, so it never means the current folder.
    let set = |name: &str| std::env::var_os(name).filter(|v| !v.is_empty());
    if let Some(dir) = set("OAH_DESKTOP_DATA_DIR").or_else(|| set("OAH_USER_DATA_DIR")) {
        return PathBuf::from(dir);
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default();
    if cfg!(target_os = "macos") {
        home.join("Library/Application Support/OpenAudioHub")
    } else if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or(home)
            .join("OpenAudioHub")
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".local/share"))
            .join("OpenAudioHub")
    }
}

/// `main.log` is moved to `main.log.1` once it reaches this size; the older copy is replaced.
const LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;

/// Holds an exclusive lock on `<data>/.instance.lock` for the life of the process, or `None`
/// when another copy of the app already holds it.
pub fn instance_lock(dir: &Path) -> Option<std::fs::File> {
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join(".instance.lock"))
        .ok()?;
    file.try_lock().ok().map(|()| file)
}

/// Appends one UTC-stamped line to `main.log`. Logging never stops the app.
pub fn log(dir: &Path, message: &str) {
    let line = format!("{} {message}\n", oah::time::iso(oah::db::now_ms()));
    eprint!("{line}");
    let path = dir.join("main.log");
    if std::fs::metadata(&path).is_ok_and(|m| m.len() >= LOG_MAX_BYTES) {
        let _ = std::fs::remove_file(dir.join("main.log.1"));
        let _ = std::fs::rename(&path, dir.join("main.log.1"));
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = f.write_all(line.as_bytes());
    }
}

/// Startup failures happen before any window exists, so they are shown with the system's dialog.
pub fn fatal_dialog(title: &str, message: &str) {
    #[cfg(target_os = "macos")]
    {
        let esc = |t: &str| t.replace('\\', "\\\\").replace('"', "\\\"");
        let script = format!(
            "display alert \"{}\" message \"{}\" as critical",
            esc(title),
            esc(message)
        );
        let _ = std::process::Command::new("osascript")
            .args(["-e", &script])
            .status();
    }
    #[cfg(not(target_os = "macos"))]
    eprintln!("{title}: {message}");
}

/// The free space the app needs on the data folder's disk (spec/desktop.md section 12).
pub const MIN_FREE_BYTES: u64 = 200 * 1024 * 1024;

/// Refuses to start when the disk that holds `folder` (or its nearest existing parent) has less than
/// `MIN_FREE_BYTES` free. A disk that cannot be read is not treated as full.
pub fn check_free_space(folder: &Path) -> Result<(), String> {
    let mut probe = folder;
    while !probe.exists() {
        match probe.parent() {
            Some(parent) => probe = parent,
            None => return Ok(()),
        }
    }
    let Ok(free) = fs4::available_space(probe) else {
        return Ok(());
    };
    if free >= MIN_FREE_BYTES {
        return Ok(());
    }
    Err(format!(
        "Only {} MB are free on the disk that holds {}. Free at least 200 MB on that disk and open OpenAudioHub again.",
        free / (1024 * 1024),
        folder.display()
    ))
}

/// Writes through a temporary file in the same folder and a rename, so a crash never leaves half a
/// file. The file gets mode 0600 on Unix, since it may hold keys or user data.
pub fn write_atomic(path: &Path, contents: &str) -> std::io::Result<()> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let temp = path.with_file_name(format!(".{name}.{}.tmp", oah::ids::token_hex(6)));
    let written = write_private(&temp, contents);
    let renamed = written.and_then(|()| std::fs::rename(&temp, path));
    if renamed.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    renamed
}

/// Creates a new file that only the owner can read or write, and fills it. The mode is set at
/// creation, so the file is never readable by others, not even briefly.
fn write_private(path: &Path, contents: &str) -> std::io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut f = options.open(path)?;
    f.write_all(contents.as_bytes())?;
    f.sync_all()
}

/// A UTC time safe for file names, such as `2026-10-16T08-00-00-000Z`.
pub fn stamp() -> String {
    oah::time::iso(oah::db::now_ms()).replace([':', '.'], "-")
}

/// `config.json`: window and launch preferences.
pub struct AppConfig {
    pub port: Option<u16>,
    pub bound_user_id: Option<String>,
    pub close_action: Option<String>,
    pub show_tray: Option<bool>,
    pub launch_at_login: Option<bool>,
    pub last_version: Option<String>,
    raw: Map<String, Value>,
}

impl AppConfig {
    pub fn load(dir: &Path) -> Result<Self, String> {
        let path = dir.join("config.json");
        let raw: Map<String, Value> = match std::fs::read_to_string(&path) {
            Err(_) => Map::new(),
            Ok(text) => match serde_json::from_str::<Value>(&text) {
                Ok(Value::Object(map)) => map,
                _ => {
                    let _ = std::fs::rename(
                        &path,
                        dir.join(format!("config.json.corrupt-{}", stamp())),
                    );
                    Map::new()
                }
            },
        };
        if raw
            .get("schemaVersion")
            .and_then(Value::as_i64)
            .is_some_and(|v| v > 1)
        {
            return Err(
                "config.json was written by a newer OpenAudioHub; install the newer version."
                    .into(),
            );
        }
        let last_version = raw
            .get("lastVersion")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if let Some(last) = &last_version
            && newer(last, env!("CARGO_PKG_VERSION"))
        {
            let this = env!("CARGO_PKG_VERSION");
            return Err(format!(
                "These files were written by OpenAudioHub {last}, which is newer than this app ({this}). Install {last} or later."
            ));
        }
        Ok(Self {
            port: raw
                .get("ports")
                .and_then(|p| p.get("app"))
                .and_then(Value::as_u64)
                .and_then(|p| u16::try_from(p).ok())
                .filter(|p| *p >= 1024),
            bound_user_id: raw
                .get("boundUserId")
                .and_then(Value::as_str)
                .map(str::to_owned),
            close_action: raw
                .get("closeAction")
                .and_then(Value::as_str)
                .map(str::to_owned),
            show_tray: raw.get("showTray").and_then(Value::as_bool),
            launch_at_login: raw.get("launchAtLogin").and_then(Value::as_bool),
            last_version,
            raw,
        })
    }

    pub fn save(&self, dir: &Path) {
        let mut raw = self.raw.clone();
        raw.insert("schemaVersion".into(), json!(1));
        if let Some(port) = self.port {
            let ports = raw.entry("ports").or_insert_with(|| json!({}));
            if let Some(p) = ports.as_object_mut() {
                p.insert("app".into(), json!(port));
            }
        }
        if let Some(v) = &self.last_version {
            raw.insert("lastVersion".into(), json!(v));
        }
        for (key, value) in [
            ("closeAction", self.close_action.as_ref().map(|v| json!(v))),
            ("showTray", self.show_tray.map(|v| json!(v))),
            ("launchAtLogin", self.launch_at_login.map(|v| json!(v))),
        ] {
            if let Some(value) = value {
                raw.insert(key.into(), value);
            }
        }
        let text = serde_json::to_string_pretty(&Value::Object(raw)).unwrap_or_default();
        if let Err(e) = write_atomic(&dir.join("config.json"), &text) {
            log(dir, &format!("could not save config.json: {e}"));
        }
    }
}

/// True when version `a` is newer than `b` (dotted numbers; anything unreadable counts as 0).
pub fn newer(a: &str, b: &str) -> bool {
    let parts = |v: &str| {
        v.split('.')
            .map(|p| p.parse::<u64>().unwrap_or(0))
            .collect::<Vec<_>>()
    };
    parts(a) > parts(b)
}

/// `secrets.json`, which holds the key that encrypts stored secrets and personal fields.
pub struct Secrets {
    pub encryption_key: String,
}

impl Secrets {
    pub fn load_or_create(dir: &Path) -> Result<Self, String> {
        let path = dir.join("secrets.json");
        let has_data = dir.join("openaudiohub.sqlite").exists() || dir.join("storage").exists();
        let parsed =
            std::fs::read_to_string(&path).map(|text| serde_json::from_str::<Value>(&text));
        let problem = match &parsed {
            Err(_) => None,
            Ok(Err(_)) => Some("it is not valid JSON".to_owned()),
            Ok(Ok(v)) => {
                let key = v
                    .get("ENCRYPTION_KEY")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if v.get("schemaVersion").and_then(Value::as_i64) != Some(1) {
                    Some("unknown schemaVersion".to_owned())
                } else if key.len() != 64 || !key.bytes().all(|b| b.is_ascii_hexdigit()) {
                    Some("ENCRYPTION_KEY is not 64 hex characters".to_owned())
                } else {
                    return Ok(Self {
                        encryption_key: key.to_owned(),
                    });
                }
            }
        };
        // Never make new keys over existing data: encrypted rows would become unreadable.
        if has_data {
            return Err(match problem {
                None => "secrets.json is missing but the database exists. Restore it from a backup; it was not regenerated.".into(),
                Some(reason) => format!("secrets.json cannot be used ({reason}). The database exists, so it was not regenerated. Restore it from a backup."),
            });
        }
        if problem.is_some() {
            let _ = std::fs::rename(&path, dir.join(format!("secrets.json.corrupt-{}", stamp())));
        }
        let encryption_key = oah::ids::token_hex(32);
        let text = serde_json::to_string_pretty(
            &json!({ "schemaVersion": 1, "ENCRYPTION_KEY": encryption_key }),
        )
        .unwrap_or_default();
        write_atomic(&path, &text).map_err(|e| format!("cannot write secrets.json: {e}"))?;
        Ok(Self { encryption_key })
    }
}

/// Settings the user may set in `openaudiohub.env` (others are ignored).
const USER_KEYS: &[&str] = &[
    "PLAUD_SYNC_RATE_LIMIT_PER_MINUTE",
    "BACKGROUND_SYNC_ENABLED",
    "BACKGROUND_SYNC_INTERVAL_MS",
    "WHISPER_MAX_BYTES",
    "WHISPER_COMPRESS_BITRATE_KBPS",
    "WHISPER_REQUEST_TIMEOUT_MS",
    "AUTO_SUMMARY_RATE_LIMIT_PER_HOUR",
];

/// The accepted `KEY=VALUE` lines of `openaudiohub.env`. Single quotes are literal, double quotes
/// accept `\n` and `\t` escapes, and an unquoted value may end with a ` #` comment.
pub fn user_env(dir: &Path) -> Vec<(String, String)> {
    let Ok(text) = std::fs::read_to_string(dir.join("openaudiohub.env")) else {
        return Vec::new();
    };
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            let (key, value) = line.split_once('=')?;
            if line.starts_with('#') || !USER_KEYS.contains(&key.trim()) {
                return None;
            }
            Some((key.trim().to_owned(), parse_value(value.trim())?))
        })
        .collect()
}

fn parse_value(raw: &str) -> Option<String> {
    if let Some(rest) = raw.strip_prefix('\'') {
        let (value, tail) = rest.split_once('\'')?;
        return tail.trim().is_empty().then(|| value.to_owned());
    }
    if let Some(rest) = raw.strip_prefix('"') {
        let mut out = String::new();
        let mut chars = rest.chars();
        while let Some(c) = chars.next() {
            match c {
                '"' => return chars.as_str().trim().is_empty().then_some(out),
                '\\' => match chars.next()? {
                    'n' => out.push('\n'),
                    't' => out.push('\t'),
                    other => out.push(other),
                },
                c => out.push(c),
            }
        }
        return None;
    }
    Some(raw.split(" #").next().unwrap_or(raw).trim().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_as_numbers() {
        assert!(newer("1.10.0", "1.9.9"));
        assert!(!newer("0.9.0", "1.0.0"));
        assert!(!newer("1.0.0", "1.0.0"));
    }

    #[test]
    fn env_values_follow_the_quoting_rules() {
        assert_eq!(
            parse_value("300000 # five minutes").as_deref(),
            Some("300000")
        );
        assert_eq!(parse_value("'a # b'").as_deref(), Some("a # b"));
        assert_eq!(
            parse_value(r#""line\nbreak""#).as_deref(),
            Some("line\nbreak")
        );
        assert_eq!(parse_value("\"unclosed"), None);
        assert_eq!(parse_value("'x' trailing"), None);
    }

    #[test]
    fn atomic_writes_are_private_and_leave_no_temp_file() {
        let dir = std::env::temp_dir().join(format!("oah-atomic-{}", oah::ids::token_hex(4)));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("export.txt");
        write_atomic(&path, "hello").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "hello");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let names: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["export.txt".to_owned()]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn secrets_are_never_regenerated_over_data() {
        let dir = std::env::temp_dir().join(format!("oah-secrets-{}", oah::ids::token_hex(4)));
        std::fs::create_dir_all(&dir).unwrap();
        let first = Secrets::load_or_create(&dir).unwrap();
        assert_eq!(
            Secrets::load_or_create(&dir).unwrap().encryption_key,
            first.encryption_key
        );
        std::fs::write(dir.join("openaudiohub.sqlite"), b"").unwrap();
        std::fs::remove_file(dir.join("secrets.json")).unwrap();
        assert!(Secrets::load_or_create(&dir).is_err());
        std::fs::remove_file(dir.join("openaudiohub.sqlite")).unwrap();
        std::fs::create_dir_all(dir.join("storage")).unwrap();
        assert!(Secrets::load_or_create(&dir).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
