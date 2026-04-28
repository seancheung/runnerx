//! Persistent app config at ~/.runnerx/config.yaml. Hand-editable on purpose.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppConfig {
    pub sandbox: SandboxConfig,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub llm: Option<LlmConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmConfig {
    pub provider: LlmProvider,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub model: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum LlmProvider {
    Openai,
    Google,
    Anthropic,
    Deepseek,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SandboxConfig {
    pub network: SandboxNetwork,
}

impl Default for SandboxConfig {
    fn default() -> Self {
        Self { network: SandboxNetwork::Bridge }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SandboxNetwork {
    None,
    Bridge,
    Host,
}

impl Default for SandboxNetwork {
    fn default() -> Self { Self::Bridge }
}

impl SandboxNetwork {
    pub fn as_docker_arg(&self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Bridge => "bridge",
            Self::Host => "host",
        }
    }
}

fn config_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    Some(PathBuf::from(home).join(".runnerx"))
}

pub fn config_path() -> Option<PathBuf> {
    config_dir().map(|d| d.join("config.yaml"))
}

/// Read the config; missing file or parse errors fall back to defaults.
pub fn load() -> AppConfig {
    let Some(p) = config_path() else { return AppConfig::default(); };
    if !p.is_file() { return AppConfig::default(); }
    let Ok(text) = std::fs::read_to_string(&p) else { return AppConfig::default(); };
    serde_yaml::from_str(&text).unwrap_or_default()
}

pub fn save(cfg: &AppConfig) -> std::io::Result<()> {
    let Some(d) = config_dir() else {
        return Err(std::io::Error::new(std::io::ErrorKind::Other, "no home dir"));
    };
    std::fs::create_dir_all(&d)?;
    let p = d.join("config.yaml");
    let yaml = serde_yaml::to_string(cfg)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    std::fs::write(p, yaml)
}
