use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum RxError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("yaml: {0}")]
    Yaml(#[from] serde_yaml::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("script not found: {0}")]
    NotFound(String),
    #[error("manifest invalid in {dir}: {message}")]
    BadManifest { dir: String, message: String },
    #[error("{0}")]
    Other(String),
}

impl Serialize for RxError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, RxError>;
