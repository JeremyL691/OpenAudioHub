//! Server configuration from environment variables (see spec/deployment.md).

use std::env;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::str::FromStr;

use crate::crypto::FieldKey;

#[derive(Clone)]
pub struct Config {
    pub listen: SocketAddr,
    /// Public origin without a trailing slash, e.g. `https://audio.example.com`.
    pub app_url: String,
    pub database_path: PathBuf,
    pub storage_root: PathBuf,
    pub storage_type: StorageType,
    pub s3: S3Config,
    pub field_key: FieldKey,
    /// Persisted hashing secret for personal API keys. Never returned to clients.
    pub api_token_hash_secret: String,
    pub disable_registration: bool,
    /// Take the client address from proxy headers (only behind a trusted proxy).
    pub trust_proxy_headers: bool,
    pub desktop: Option<Desktop>,
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
    /// Long and large recordings go through the in-process audio pipeline.
    pub pipeline_enabled: bool,
    /// Plaud API base for tests (`OAH_PLAUD_API_BASE`); `None` means the real regional hosts.
    pub plaud_api_base: Option<String>,
    /// Outgoing email (test email, notifications, password reset). Environment only.
    pub smtp: SmtpConfig,
}

/// SMTP settings (spec/deployment.md 2.7). Email is on only when host, user and password are set.
#[derive(Clone, Default)]
pub struct SmtpConfig {
    pub host: Option<String>,
    pub port: u16,
    /// `true` uses implicit TLS, `false` uses STARTTLS.
    pub secure: bool,
    pub user: Option<String>,
    pub password: Option<String>,
    /// Bare address or `Name <address>`, checked at startup.
    pub from: Option<String>,
    /// Bare address or `Name <address>`, checked at startup.
    pub reply_to: Option<String>,
}

impl SmtpConfig {
    fn from_env() -> Result<Self, ConfigError> {
        // Lenient boolean: only the exact text `true` turns it on.
        let secure = var("SMTP_SECURE").as_deref() == Some("true");
        let port = match var("SMTP_PORT") {
            None => {
                if secure {
                    465
                } else {
                    587
                }
            }
            Some(raw) => raw
                .parse::<u16>()
                .map_err(|_| ConfigError("SMTP_PORT must be a port number".into()))?,
        };
        let address = |name: &str| -> Result<Option<String>, ConfigError> {
            match var(name) {
                None => Ok(None),
                Some(raw) => {
                    lettre::message::Mailbox::from_str(&raw).map_err(|_| {
                        ConfigError(format!("{name} must be an address or Name <address>"))
                    })?;
                    Ok(Some(raw))
                }
            }
        };
        Ok(Self {
            host: var("SMTP_HOST"),
            port,
            secure,
            user: var("SMTP_USER"),
            password: var("SMTP_PASSWORD"),
            from: address("SMTP_FROM")?,
            reply_to: address("SMTP_REPLY_TO")?,
        })
    }

    /// Email is on when host, user and password are all set.
    pub fn configured(&self) -> bool {
        self.host.is_some() && self.user.is_some() && self.password.is_some()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StorageType {
    Local,
    S3,
}

#[derive(Clone)]
pub struct S3Config {
    pub endpoint: Option<String>,
    pub bucket: Option<String>,
    pub region: Option<String>,
    pub access_key_id: Option<String>,
    pub secret_access_key: Option<String>,
}

impl S3Config {
    fn from_env() -> Self {
        Self {
            endpoint: var("S3_ENDPOINT"),
            bucket: var("S3_BUCKET"),
            region: var("S3_REGION"),
            access_key_id: var("S3_ACCESS_KEY_ID"),
            secret_access_key: var("S3_SECRET_ACCESS_KEY"),
        }
    }
}

/// Desktop mode: one local account, signed in with a per-launch secret.
#[derive(Clone)]
pub struct Desktop {
    pub launch_secret: String,
    pub user_id: Option<String>,
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct ConfigError(String);

fn var(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
}

fn required(name: &str) -> Result<String, ConfigError> {
    var(name).ok_or_else(|| ConfigError(format!("{name} must be set")))
}

fn api_hash_secret(
    encryption_key: &str,
    desktop_dir: Option<&std::path::Path>,
) -> Result<String, ConfigError> {
    let inherited = desktop_dir.and_then(|dir| {
        let value: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("secrets.json")).ok()?).ok()?;
        ["API_TOKEN_HASH_SECRET"].iter().find_map(|name| {
            value
                .get(name)?
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .map(str::to_owned)
        })
    });
    let explicit = var("API_TOKEN_HASH_SECRET").or(inherited);
    if let Some(secret) = explicit {
        if secret.len() < 32 {
            return Err(ConfigError(
                "API_TOKEN_HASH_SECRET is too short; use at least 32 characters.".into(),
            ));
        }
        return Ok(secret);
    }
    // Without a configured secret, derive a separate, stable key instead of inventing
    // a transient value that invalidates keys on restart.
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    let mut mac = Hmac::<Sha256>::new_from_slice(encryption_key.as_bytes())
        .map_err(|_| ConfigError("invalid API hashing key".into()))?;
    mac.update(b"OpenAudioHub personal API keys v2");
    Ok(hex::encode(mac.finalize().into_bytes()))
}

/// `true/1/yes/on` and `false/0/no/off`, any case; unset means `default`.
fn flag(name: &str, default: bool) -> Result<bool, ConfigError> {
    match var(name).map(|v| v.to_ascii_lowercase()).as_deref() {
        None => Ok(default),
        Some("true" | "1" | "yes" | "on") => Ok(true),
        Some("false" | "0" | "no" | "off") => Ok(false),
        Some(_) => Err(ConfigError(format!("{name} must be true or false"))),
    }
}

/// A whole-number setting from the environment, checked against a range. Unset uses `default`.
pub fn number(name: &str, default: u64, min: u64, max: u64) -> Result<u64, ConfigError> {
    let Some(raw) = var(name) else {
        return Ok(default);
    };
    match raw.parse::<u64>() {
        Ok(n) if (min..=max).contains(&n) => Ok(n),
        _ => Err(ConfigError(format!(
            "{name} must be a whole number from {min} to {max}"
        ))),
    }
}

/// A true/false setting from the environment. Unset uses `default`.
pub fn boolean(name: &str, default: bool) -> Result<bool, ConfigError> {
    flag(name, default)
}

fn desktop() -> Result<Option<Desktop>, ConfigError> {
    if !flag("OAH_DESKTOP", false)? {
        return Ok(None);
    }
    let launch_secret = required("OAH_DESKTOP_LAUNCH_SECRET")?;
    if launch_secret.len() < 32 {
        return Err(ConfigError(
            "OAH_DESKTOP_LAUNCH_SECRET must be at least 32 characters".into(),
        ));
    }
    Ok(Some(Desktop {
        launch_secret,
        user_id: var("OAH_DESKTOP_USER_ID"),
    }))
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        let data_dir = PathBuf::from(var("OAH_DATA_DIR").unwrap_or_else(|| "./data".into()));
        let port: u16 = var("PORT")
            .unwrap_or_else(|| "3000".into())
            .parse()
            .map_err(|_| ConfigError("PORT must be a number".into()))?;
        let host: IpAddr = var("HOST")
            .map(|h| {
                h.parse()
                    .map_err(|_| ConfigError("HOST must be an IP address".into()))
            })
            .transpose()?
            .unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED));
        let app_url = var("APP_URL").unwrap_or_else(|| format!("http://localhost:{port}"));
        let storage_type = match var("DEFAULT_STORAGE_TYPE").as_deref().unwrap_or("local") {
            "local" => StorageType::Local,
            "s3" => StorageType::S3,
            _ => {
                return Err(ConfigError(
                    "DEFAULT_STORAGE_TYPE must be local or s3".into(),
                ));
            }
        };
        let field_key = FieldKey::from_hex(&required("ENCRYPTION_KEY")?)
            .map_err(|e| ConfigError(e.to_string()))?;
        let api_token_hash_secret = api_hash_secret(&required("ENCRYPTION_KEY")?, None)?;
        Ok(Self {
            listen: SocketAddr::new(host, port),
            app_url: app_url.trim_end_matches('/').to_owned(),
            database_path: var("OAH_DATABASE_PATH")
                .map(PathBuf::from)
                .unwrap_or_else(|| data_dir.join("openaudiohub.sqlite")),
            storage_root: var("LOCAL_STORAGE_PATH")
                .map(PathBuf::from)
                .unwrap_or_else(|| data_dir.join("storage")),
            storage_type,
            s3: S3Config::from_env(),
            field_key,
            api_token_hash_secret,
            disable_registration: flag("DISABLE_REGISTRATION", false)?,
            trust_proxy_headers: flag("RATE_LIMIT_TRUST_PROXY_HEADERS", false)?,
            desktop: desktop()?,
            ffmpeg: var("FFMPEG_PATH").unwrap_or_else(|| "ffmpeg".into()).into(),
            ffprobe: var("FFPROBE_PATH")
                .unwrap_or_else(|| "ffprobe".into())
                .into(),
            pipeline_enabled: flag("AUDIO_PIPELINE_ENABLED", true)?,
            plaud_api_base: var("OAH_PLAUD_API_BASE").map(|v| v.trim_end_matches('/').to_owned()),
            smtp: SmtpConfig::from_env()?,
        })
    }

    /// The desktop app's server: local-only, data in the app's data folder, signed in through
    /// the one-time launch code. Other settings still come from the environment.
    pub fn desktop(
        data_dir: &std::path::Path,
        key_hex: &str,
        port: u16,
        launch_code: &str,
        user_id: Option<String>,
    ) -> Result<Self, ConfigError> {
        let field_key = FieldKey::from_hex(key_hex).map_err(|e| ConfigError(e.to_string()))?;
        Ok(Self {
            listen: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port),
            app_url: format!("http://127.0.0.1:{port}"),
            database_path: data_dir.join("openaudiohub.sqlite"),
            storage_root: data_dir.join("storage"),
            storage_type: StorageType::Local,
            s3: S3Config::from_env(),
            field_key,
            api_token_hash_secret: api_hash_secret(key_hex, Some(data_dir))?,
            disable_registration: true,
            trust_proxy_headers: false,
            desktop: Some(Desktop {
                launch_secret: launch_code.to_owned(),
                user_id,
            }),
            ffmpeg: var("FFMPEG_PATH").unwrap_or_else(|| "ffmpeg".into()).into(),
            ffprobe: var("FFPROBE_PATH")
                .unwrap_or_else(|| "ffprobe".into())
                .into(),
            pipeline_enabled: true,
            plaud_api_base: var("OAH_PLAUD_API_BASE").map(|v| v.trim_end_matches('/').to_owned()),
            smtp: SmtpConfig::from_env()?,
        })
    }

    /// A config for tests: random keys, paths under `dir`.
    pub fn for_tests(dir: &std::path::Path) -> Self {
        Self {
            listen: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
            app_url: "http://localhost:3000".into(),
            database_path: dir.join("test.sqlite"),
            storage_root: dir.join("storage"),
            storage_type: StorageType::Local,
            s3: S3Config {
                endpoint: None,
                bucket: None,
                region: None,
                access_key_id: None,
                secret_access_key: None,
            },
            field_key: FieldKey::from_hex(&crate::ids::token_hex(32)).expect("valid test key"),
            api_token_hash_secret: crate::ids::token_hex(32),
            disable_registration: false,
            trust_proxy_headers: true,
            desktop: None,
            ffmpeg: "ffmpeg".into(),
            ffprobe: "ffprobe".into(),
            pipeline_enabled: false,
            plaud_api_base: None,
            smtp: SmtpConfig {
                port: 587,
                ..SmtpConfig::default()
            },
        }
    }
}
