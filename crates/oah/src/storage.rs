//! Audio object storage. The active backend receives new uploads; stored recordings
//! keep their own `storage_type` so changing the server default never strands data.
//!
//! Callers stage uploads to a file and use `put_file` (streamed from disk), or use
//! `materialize` when a local path is required by ffmpeg/zip. S3 reads are streamed
//! to a unique temporary file and removed when the returned guard is dropped.

use std::path::{Component, Path, PathBuf};
use std::pin::Pin;
use std::time::Duration;

use aws_credential_types::Credentials;
use aws_sdk_s3::Client;
use aws_sdk_s3::config::Region;
use aws_sdk_s3::presigning::PresigningConfig;
use aws_sdk_s3::primitives::ByteStream;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

use crate::config::{Config, S3Config, StorageType};
use crate::error::AppError;
use crate::ids::token_hex;

const OPERATION_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const PRESIGN_TIMEOUT: Duration = Duration::from_secs(300);

/// A readable audio byte stream from either backend.
pub type AudioReader = Pin<Box<dyn AsyncRead + Send>>;

#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error("invalid storage key")]
    InvalidKey,
    #[error("S3 storage is missing required configuration")]
    NotConfigured,
    #[error("storage object was not found")]
    NotFound,
    #[error("storage operation failed")]
    Operation,
    #[error("not enough local disk space to materialize audio")]
    InsufficientSpace,
}

impl From<StorageError> for AppError {
    fn from(e: StorageError) -> Self {
        match e {
            StorageError::NotFound => {
                AppError::not_found("RECORDING_NOT_FOUND", "Audio file is missing")
            }
            other => AppError::internal(other),
        }
    }
}

#[derive(Clone)]
pub struct Storage {
    active: StorageType,
    local_root: PathBuf,
    s3: Option<S3Client>,
}

#[derive(Clone)]
struct S3Client {
    client: Client,
    bucket: String,
}

/// A local file usable by path-based media tools. Temporary S3 downloads are cleaned
/// up with this guard, including early-return/error paths.
pub struct LocalFile {
    path: PathBuf,
    cleanup: bool,
}

impl LocalFile {
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for LocalFile {
    fn drop(&mut self) {
        if self.cleanup {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

impl Storage {
    pub fn new(config: &Config) -> Self {
        let s3 = make_s3_client(&config.s3);
        Self {
            active: config.storage_type,
            local_root: config.storage_root.clone(),
            s3,
        }
    }

    pub fn active_type(&self) -> &'static str {
        match self.active {
            StorageType::Local => "local",
            StorageType::S3 => "s3",
        }
    }

    /// A path for local objects only. The key must be a safe relative object path.
    pub fn local_path(&self, kind: &str, key: &str) -> Result<Option<PathBuf>, StorageError> {
        validate_key(key)?;
        if kind == "local" {
            Ok(Some(self.local_root.join(key)))
        } else if kind == "s3" {
            Ok(None)
        } else {
            Err(StorageError::Operation)
        }
    }

    /// Store a staged file using the server's active backend. File bytes are streamed;
    /// they are never collected into a memory buffer.
    pub async fn put_file(
        &self,
        key: &str,
        source: &Path,
        content_type: Option<&str>,
    ) -> Result<(), StorageError> {
        validate_key(key)?;
        match self.active {
            StorageType::Local => {
                let dest = self.local_root.join(key);
                let parent = dest.parent().ok_or(StorageError::InvalidKey)?;
                tokio::fs::create_dir_all(parent)
                    .await
                    .map_err(|_| StorageError::Operation)?;
                let temp = parent.join(format!(".upload-{}", token_hex(12)));
                if tokio::fs::copy(source, &temp).await.is_err() {
                    let _ = tokio::fs::remove_file(&temp).await;
                    return Err(StorageError::Operation);
                }
                if tokio::fs::rename(&temp, &dest).await.is_err() {
                    let _ = tokio::fs::remove_file(&temp).await;
                    return Err(StorageError::Operation);
                }
                Ok(())
            }
            StorageType::S3 => {
                let s3 = self.s3.as_ref().ok_or(StorageError::NotConfigured)?;
                let body = ByteStream::read_from()
                    .path(source)
                    .build()
                    .await
                    .map_err(|_| StorageError::Operation)?;
                let mut request = s3
                    .client
                    .put_object()
                    .bucket(&s3.bucket)
                    .key(key)
                    .body(body);
                if let Some(content_type) = content_type {
                    request = request.content_type(content_type);
                }
                tokio::time::timeout(OPERATION_TIMEOUT, request.send())
                    .await
                    .map_err(|_| StorageError::Operation)?
                    .map_err(|_| StorageError::Operation)?;
                Ok(())
            }
        }
    }

    /// Stream an object to a destination file. `kind` is read from the recording row,
    /// not from the current server default.
    pub async fn get_file(
        &self,
        kind: &str,
        key: &str,
        destination: &Path,
    ) -> Result<u64, StorageError> {
        validate_key(key)?;
        if let Some(parent) = destination.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|_| StorageError::Operation)?;
        }
        if kind == "local" {
            let source = self.local_root.join(key);
            let size = tokio::fs::metadata(&source)
                .await
                .map_err(|e| {
                    if e.kind() == std::io::ErrorKind::NotFound {
                        StorageError::NotFound
                    } else {
                        StorageError::Operation
                    }
                })?
                .len();
            tokio::fs::copy(source, destination)
                .await
                .map_err(|_| StorageError::Operation)?;
            return Ok(size);
        }
        let s3 = self.s3.as_ref().ok_or(StorageError::NotConfigured)?;
        ensure_disk_budget(destination, self.head_size(kind, key).await?).await?;
        let response = tokio::time::timeout(
            OPERATION_TIMEOUT,
            s3.client.get_object().bucket(&s3.bucket).key(key).send(),
        )
        .await
        .map_err(|_| StorageError::Operation)?
        .map_err(map_get_error)?;
        let size = response.content_length().unwrap_or_default().max(0) as u64;
        if let Some(parent) = destination.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|_| StorageError::Operation)?;
        }
        let mut file = tokio::fs::File::create(destination)
            .await
            .map_err(|_| StorageError::Operation)?;
        let mut body = response.body.into_async_read();
        tokio::time::timeout(OPERATION_TIMEOUT, tokio::io::copy(&mut body, &mut file))
            .await
            .map_err(|_| StorageError::Operation)?
            .map_err(|_| StorageError::Operation)?;
        file.flush().await.map_err(|_| StorageError::Operation)?;
        Ok(size)
    }

    /// Put a staged file under `key` on the active backend. Local storage renames the staged
    /// file into place; S3 uploads it and then removes the staged file. The staged file is gone
    /// on success in both cases.
    pub async fn store_staged(
        &self,
        key: &str,
        staged: &Path,
        content_type: Option<&str>,
    ) -> Result<(), StorageError> {
        validate_key(key)?;
        match self.active {
            StorageType::Local => {
                let dest = self.local_root.join(key);
                let parent = dest.parent().ok_or(StorageError::InvalidKey)?;
                tokio::fs::create_dir_all(parent)
                    .await
                    .map_err(|_| StorageError::Operation)?;
                tokio::fs::rename(staged, &dest)
                    .await
                    .map_err(|_| StorageError::Operation)
            }
            StorageType::S3 => {
                self.put_file(key, staged, content_type).await?;
                let _ = tokio::fs::remove_file(staged).await;
                Ok(())
            }
        }
    }

    /// Open a byte range of a stored object. `start` and `end` are inclusive; `end: None`
    /// reads to the last byte. `kind` is the backend recorded on the row.
    pub async fn open_range(
        &self,
        kind: &str,
        key: &str,
        start: u64,
        end: Option<u64>,
    ) -> Result<AudioReader, StorageError> {
        validate_key(key)?;
        if kind == "local" {
            let mut file = tokio::fs::File::open(self.local_root.join(key))
                .await
                .map_err(|e| {
                    if e.kind() == std::io::ErrorKind::NotFound {
                        StorageError::NotFound
                    } else {
                        StorageError::Operation
                    }
                })?;
            if start > 0 {
                file.seek(std::io::SeekFrom::Start(start))
                    .await
                    .map_err(|_| StorageError::Operation)?;
            }
            return Ok(match end {
                Some(end) => Box::pin(file.take(end.saturating_sub(start) + 1)),
                None => Box::pin(file),
            });
        }
        let s3 = self.s3.as_ref().ok_or(StorageError::NotConfigured)?;
        let range = match end {
            Some(end) => format!("bytes={start}-{end}"),
            None => format!("bytes={start}-"),
        };
        let response = tokio::time::timeout(
            OPERATION_TIMEOUT,
            s3.client
                .get_object()
                .bucket(&s3.bucket)
                .key(key)
                .range(range)
                .send(),
        )
        .await
        .map_err(|_| StorageError::Operation)?
        .map_err(map_get_error)?;
        Ok(Box::pin(response.body.into_async_read()))
    }

    pub async fn delete(&self, kind: &str, key: &str) -> Result<(), StorageError> {
        validate_key(key)?;
        if kind == "local" {
            return match tokio::fs::remove_file(self.local_root.join(key)).await {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(_) => Err(StorageError::Operation),
            };
        }
        let s3 = self.s3.as_ref().ok_or(StorageError::NotConfigured)?;
        tokio::time::timeout(
            OPERATION_TIMEOUT,
            s3.client.delete_object().bucket(&s3.bucket).key(key).send(),
        )
        .await
        .map_err(|_| StorageError::Operation)?
        .map_err(|_| StorageError::Operation)?;
        Ok(())
    }

    pub async fn head_size(&self, kind: &str, key: &str) -> Result<u64, StorageError> {
        validate_key(key)?;
        if kind == "local" {
            return tokio::fs::metadata(self.local_root.join(key))
                .await
                .map(|m| m.len())
                .map_err(|e| {
                    if e.kind() == std::io::ErrorKind::NotFound {
                        StorageError::NotFound
                    } else {
                        StorageError::Operation
                    }
                });
        }
        let s3 = self.s3.as_ref().ok_or(StorageError::NotConfigured)?;
        let result = tokio::time::timeout(
            OPERATION_TIMEOUT,
            s3.client.head_object().bucket(&s3.bucket).key(key).send(),
        )
        .await
        .map_err(|_| StorageError::Operation)?
        .map_err(map_head_error)?;
        result
            .content_length()
            .filter(|n| *n >= 0)
            .map(|n| n as u64)
            .ok_or(StorageError::Operation)
    }

    /// Create a private GET URL for S3 objects. Local objects return `None`.
    pub async fn presigned_get(
        &self,
        kind: &str,
        key: &str,
    ) -> Result<Option<String>, StorageError> {
        validate_key(key)?;
        if kind == "local" {
            return Ok(None);
        }
        let s3 = self.s3.as_ref().ok_or(StorageError::NotConfigured)?;
        let config =
            PresigningConfig::expires_in(PRESIGN_TIMEOUT).map_err(|_| StorageError::Operation)?;
        let request = tokio::time::timeout(
            Duration::from_secs(15),
            s3.client
                .get_object()
                .bucket(&s3.bucket)
                .key(key)
                .presigned(config),
        )
        .await
        .map_err(|_| StorageError::Operation)?
        .map_err(|_| StorageError::Operation)?;
        Ok(Some(request.uri().to_owned()))
    }

    /// Return the existing local object, or stream an S3 object into a managed temporary
    /// file. Disk space is checked before the S3 transfer starts.
    pub async fn materialize(&self, kind: &str, key: &str) -> Result<LocalFile, StorageError> {
        validate_key(key)?;
        if kind == "local" {
            let path = self.local_root.join(key);
            tokio::fs::metadata(&path).await.map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    StorageError::NotFound
                } else {
                    StorageError::Operation
                }
            })?;
            return Ok(LocalFile {
                path,
                cleanup: false,
            });
        }
        let size = self.head_size(kind, key).await?;
        let dir = self.local_root.join(".materialized");
        tokio::fs::create_dir_all(&dir)
            .await
            .map_err(|_| StorageError::Operation)?;
        let path = dir.join(token_hex(16));
        ensure_disk_budget(&path, size).await?;
        if let Err(error) = self.get_file(kind, key, &path).await {
            let _ = tokio::fs::remove_file(&path).await;
            return Err(error);
        }
        Ok(LocalFile {
            path,
            cleanup: true,
        })
    }

    pub fn disk_free_bytes(&self) -> Option<u64> {
        if self.active != StorageType::Local {
            return None;
        }
        fs4::available_space(&self.local_root).ok()
    }
}

fn make_s3_client(settings: &S3Config) -> Option<S3Client> {
    let bucket = settings.bucket.clone()?;
    let region = settings.region.clone()?;
    let access = settings.access_key_id.clone()?;
    let secret = settings.secret_access_key.clone()?;
    let credentials = Credentials::new(access, secret, None, None, "openaudiohub-static-s3");
    let mut builder = aws_sdk_s3::Config::builder()
        .behavior_version_latest()
        .region(Region::new(region))
        .credentials_provider(credentials)
        .force_path_style(true);
    if let Some(endpoint) = settings.endpoint.as_deref() {
        builder = builder.endpoint_url(endpoint);
    }
    Some(S3Client {
        client: Client::from_conf(builder.build()),
        bucket,
    })
}

fn validate_key(key: &str) -> Result<(), StorageError> {
    let path = Path::new(key);
    if key.is_empty()
        || path.is_absolute()
        || key.contains('\\')
        || path
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(StorageError::InvalidKey);
    }
    Ok(())
}

fn map_head_error<R>(
    e: aws_sdk_s3::error::SdkError<aws_sdk_s3::operation::head_object::HeadObjectError, R>,
) -> StorageError {
    match e.as_service_error() {
        Some(service) if service.is_not_found() => StorageError::NotFound,
        _ => StorageError::Operation,
    }
}

fn map_get_error<R>(
    e: aws_sdk_s3::error::SdkError<aws_sdk_s3::operation::get_object::GetObjectError, R>,
) -> StorageError {
    match e.as_service_error() {
        Some(service) if service.is_no_such_key() => StorageError::NotFound,
        _ => StorageError::Operation,
    }
}

async fn ensure_disk_budget(path: &Path, bytes: u64) -> Result<(), StorageError> {
    let parent = path.parent().ok_or(StorageError::InvalidKey)?;
    let available = fs4::available_space(parent).map_err(|_| StorageError::Operation)?;
    if available < bytes {
        return Err(StorageError::InsufficientSpace);
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod fake_s3 {
    //! A tiny in-process S3 stand-in: PUT, HEAD, GET (with single `Range`), DELETE, path-style.
    use super::*;
    use axum::Router;
    use axum::body::{Body, to_bytes};
    use axum::extract::State as AxumState;
    use axum::http::{Method, Request, StatusCode, header};
    use axum::response::{IntoResponse, Response};
    use axum::routing::any;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    pub type Objects = Arc<Mutex<HashMap<String, Vec<u8>>>>;

    /// Starts the fake on a random port. Returns its endpoint, the object map and the server task.
    pub async fn start() -> (String, Objects, tokio::task::JoinHandle<()>) {
        let objects: Objects = Arc::new(Mutex::new(HashMap::new()));
        let app = Router::new()
            .route("/{*key}", any(handle))
            .with_state(objects.clone());
        // Start the listener first so the SDK always gets a stable endpoint.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (endpoint, objects, server)
    }

    /// S3 settings that point at the fake endpoint.
    pub fn s3_settings(endpoint: String) -> S3Config {
        S3Config {
            endpoint: Some(endpoint),
            bucket: Some("test-bucket".into()),
            region: Some("us-east-1".into()),
            access_key_id: Some("local-test-access".into()),
            secret_access_key: Some("local-test-secret".into()),
        }
    }

    async fn handle(AxumState(objects): AxumState<Objects>, request: Request<Body>) -> Response {
        let key = request
            .uri()
            .path()
            .trim_start_matches("/test-bucket/")
            .to_owned();
        match *request.method() {
            Method::PUT => {
                let wire = to_bytes(request.into_body(), 16 * 1024 * 1024)
                    .await
                    .unwrap()
                    .to_vec();
                let bytes = decode_s3_chunks(&wire);
                objects.lock().unwrap().insert(key, bytes);
                StatusCode::OK.into_response()
            }
            Method::HEAD => match objects.lock().unwrap().get(&key) {
                Some(bytes) => Response::builder()
                    .status(StatusCode::OK)
                    .header(header::CONTENT_LENGTH, bytes.len().to_string())
                    .body(Body::empty())
                    .unwrap(),
                None => StatusCode::NOT_FOUND.into_response(),
            },
            Method::GET => {
                let Some(bytes) = objects.lock().unwrap().get(&key).cloned() else {
                    return StatusCode::NOT_FOUND.into_response();
                };
                let range = request
                    .headers()
                    .get(header::RANGE)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| parse_range(v, bytes.len()));
                match range {
                    Some((start, end)) => {
                        let slice = bytes[start..=end].to_vec();
                        Response::builder()
                            .status(StatusCode::PARTIAL_CONTENT)
                            .header(header::CONTENT_LENGTH, slice.len().to_string())
                            .header(
                                header::CONTENT_RANGE,
                                format!("bytes {start}-{end}/{}", bytes.len()),
                            )
                            .body(Body::from(slice))
                            .unwrap()
                    }
                    None => Response::builder()
                        .status(StatusCode::OK)
                        .header(header::CONTENT_LENGTH, bytes.len().to_string())
                        .body(Body::from(bytes))
                        .unwrap(),
                }
            }
            Method::DELETE => {
                objects.lock().unwrap().remove(&key);
                StatusCode::NO_CONTENT.into_response()
            }
            _ => StatusCode::METHOD_NOT_ALLOWED.into_response(),
        }
    }

    /// `bytes=START-END` or `bytes=START-`, clamped to the object. None when unusable.
    fn parse_range(value: &str, len: usize) -> Option<(usize, usize)> {
        let spec = value.strip_prefix("bytes=")?;
        let (start, end) = spec.split_once('-')?;
        let start: usize = start.parse().ok()?;
        let last = len.checked_sub(1)?;
        let end = if end.is_empty() {
            last
        } else {
            end.parse::<usize>().ok()?.min(last)
        };
        (start <= end).then_some((start, end))
    }

    fn decode_s3_chunks(wire: &[u8]) -> Vec<u8> {
        let mut output = Vec::new();
        let mut cursor = 0;
        while let Some(relative_end) = wire[cursor..].windows(2).position(|w| w == b"\r\n") {
            let end = cursor + relative_end;
            let line = std::str::from_utf8(&wire[cursor..end]).unwrap_or("");
            let size_text = line.split(';').next().unwrap_or("");
            let Ok(size) = usize::from_str_radix(size_text, 16) else {
                return wire.to_vec();
            };
            cursor = end + 2;
            if size == 0 {
                return output;
            }
            if cursor + size + 2 > wire.len() {
                return wire.to_vec();
            }
            output.extend_from_slice(&wire[cursor..cursor + size]);
            cursor += size + 2;
        }
        wire.to_vec()
    }
}

#[cfg(test)]
mod tests {
    use super::fake_s3;
    use super::*;
    use tempfile::tempdir;

    async fn read_all(mut reader: AudioReader) -> Vec<u8> {
        let mut out = Vec::new();
        reader.read_to_end(&mut out).await.unwrap();
        out
    }

    #[tokio::test]
    async fn local_storage_streams_files_and_rejects_unsafe_keys() {
        let dir = tempdir().unwrap();
        let config = Config::for_tests(dir.path());
        let storage = Storage::new(&config);
        let source = dir.path().join("source.mp3");
        tokio::fs::write(&source, b"local audio").await.unwrap();
        storage
            .put_file("user/recording.mp3", &source, Some("audio/mpeg"))
            .await
            .unwrap();
        assert_eq!(storage.active_type(), "local");
        assert_eq!(
            storage
                .head_size("local", "user/recording.mp3")
                .await
                .unwrap(),
            11
        );
        let read = dir.path().join("readback.mp3");
        storage
            .get_file("local", "user/recording.mp3", &read)
            .await
            .unwrap();
        assert_eq!(tokio::fs::read(read).await.unwrap(), b"local audio");
        storage.delete("local", "user/recording.mp3").await.unwrap();
        assert!(storage.local_path("local", "../private").is_err());
    }

    #[tokio::test]
    async fn s3_put_get_delete_and_presign_use_the_configured_bucket() {
        let dir = tempdir().unwrap();
        let (endpoint, objects, server) = fake_s3::start().await;
        let mut config = Config::for_tests(dir.path());
        config.storage_type = StorageType::S3;
        config.s3 = fake_s3::s3_settings(endpoint);
        let storage = Storage::new(&config);
        let source = dir.path().join("source.mp3");
        tokio::fs::write(&source, b"fake S3 audio object")
            .await
            .unwrap();
        storage
            .put_file("user/recording.mp3", &source, Some("audio/mpeg"))
            .await
            .unwrap();
        assert_eq!(storage.active_type(), "s3");
        assert_eq!(
            storage.head_size("s3", "user/recording.mp3").await.unwrap(),
            20
        );
        let signed = storage
            .presigned_get("s3", "user/recording.mp3")
            .await
            .unwrap()
            .unwrap();
        assert!(signed.contains("/test-bucket/user/recording.mp3"));
        assert!(signed.contains("X-Amz-Expires=300"));
        let read = dir.path().join("downloads/readback.mp3");
        assert_eq!(
            storage
                .get_file("s3", "user/recording.mp3", &read)
                .await
                .unwrap(),
            20
        );
        assert_eq!(
            tokio::fs::read(read).await.unwrap(),
            b"fake S3 audio object"
        );
        let temp = storage
            .materialize("s3", "user/recording.mp3")
            .await
            .unwrap();
        let temp_path = temp.path().to_path_buf();
        assert!(temp_path.exists());
        drop(temp);
        assert!(!temp_path.exists());
        storage.delete("s3", "user/recording.mp3").await.unwrap();
        assert_eq!(objects.lock().unwrap().len(), 0);
        server.abort();
    }

    #[tokio::test]
    async fn s3_upload_range_delete_and_mixed_library() {
        let dir = tempdir().unwrap();
        let (endpoint, objects, server) = fake_s3::start().await;
        let mut config = Config::for_tests(dir.path());
        config.storage_type = StorageType::S3;
        config.s3 = fake_s3::s3_settings(endpoint.clone());
        let s3_default = Storage::new(&config);
        // A server whose default is local shares the same folder and can still read S3 rows.
        let mut local_config = Config::for_tests(dir.path());
        local_config.storage_type = StorageType::Local;
        local_config.s3 = fake_s3::s3_settings(endpoint);
        let local_default = Storage::new(&local_config);

        // Upload under the S3 default: the staged file is moved to the bucket.
        let staged = dir.path().join("staged.mp3");
        tokio::fs::write(&staged, b"0123456789").await.unwrap();
        s3_default
            .store_staged("user/s3.mp3", &staged, Some("audio/mpeg"))
            .await
            .unwrap();
        assert!(!staged.exists());
        assert_eq!(
            objects.lock().unwrap().get("user/s3.mp3").cloned(),
            Some(b"0123456789".to_vec())
        );

        // Ranged reads come from the object.
        assert_eq!(
            read_all(
                s3_default
                    .open_range("s3", "user/s3.mp3", 2, Some(5))
                    .await
                    .unwrap()
            )
            .await,
            b"2345"
        );
        assert_eq!(
            read_all(
                s3_default
                    .open_range("s3", "user/s3.mp3", 7, None)
                    .await
                    .unwrap()
            )
            .await,
            b"789"
        );
        assert_eq!(s3_default.head_size("s3", "user/s3.mp3").await.unwrap(), 10);

        // A local row, written by the local backend into the same folder.
        let staged_local = dir.path().join("staged-local.mp3");
        tokio::fs::write(&staged_local, b"local audio")
            .await
            .unwrap();
        local_default
            .store_staged("user/local.mp3", &staged_local, Some("audio/mpeg"))
            .await
            .unwrap();
        assert!(!staged_local.exists());

        // Each row is read from its own backend, whichever is the default.
        assert_eq!(
            read_all(
                s3_default
                    .open_range("local", "user/local.mp3", 0, Some(4))
                    .await
                    .unwrap()
            )
            .await,
            b"local"
        );
        assert_eq!(
            read_all(
                local_default
                    .open_range("s3", "user/s3.mp3", 0, None)
                    .await
                    .unwrap()
            )
            .await,
            b"0123456789"
        );
        assert_eq!(
            s3_default
                .head_size("local", "user/local.mp3")
                .await
                .unwrap(),
            11
        );
        assert!(
            s3_default
                .presigned_get("local", "user/local.mp3")
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            s3_default
                .presigned_get("s3", "user/s3.mp3")
                .await
                .unwrap()
                .is_some()
        );
        let fetched = s3_default.materialize("s3", "user/s3.mp3").await.unwrap();
        assert_eq!(
            tokio::fs::read(fetched.path()).await.unwrap(),
            b"0123456789"
        );
        drop(fetched);

        // Delete both kinds.
        s3_default.delete("s3", "user/s3.mp3").await.unwrap();
        assert!(objects.lock().unwrap().is_empty());
        assert!(matches!(
            s3_default.head_size("s3", "user/s3.mp3").await,
            Err(StorageError::NotFound)
        ));
        s3_default.delete("local", "user/local.mp3").await.unwrap();
        assert!(matches!(
            local_default.head_size("local", "user/local.mp3").await,
            Err(StorageError::NotFound)
        ));
        server.abort();
    }
}
