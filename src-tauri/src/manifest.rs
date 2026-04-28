use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ArgsMode {
    Env,
    Argv,
    StdinJson,
}

impl Default for ArgsMode {
    fn default() -> Self {
        ArgsMode::Env
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandSpec {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub shell: bool,
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntrySpec {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub shell: bool,
    pub cwd: Option<String>,
    #[serde(default)]
    pub args_mode: ArgsMode,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lifecycle {
    pub install: Option<CommandSpec>,
    pub uninstall: Option<CommandSpec>,
    pub pre_run: Option<CommandSpec>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformOverride {
    pub entry: Option<EntrySpec>,
    pub lifecycle: Option<Lifecycle>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Platform {
    pub windows: Option<PlatformOverride>,
    pub macos: Option<PlatformOverride>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum InputType {
    String,
    Number,
    Boolean,
    Enum,
    File,
    Files,
    Directory,
    Password,
    Date,
    Json,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum WhenValue {
    Single(serde_json::Value),
    Many(Vec<serde_json::Value>),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum EnumOption {
    Plain(String),
    Detailed {
        value: serde_json::Value,
        label: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputSpec {
    pub id: String,
    #[serde(rename = "type")]
    pub ty: InputType,
    pub label: Option<String>,
    pub description: Option<String>,
    #[serde(default)]
    pub required: bool,
    pub default: Option<serde_json::Value>,
    pub placeholder: Option<String>,
    pub when: Option<HashMap<String, WhenValue>>,

    // string-only
    #[serde(default)]
    pub multiline: bool,
    pub pattern: Option<String>,
    pub min_length: Option<usize>,
    pub max_length: Option<usize>,
    // number-only
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub step: Option<f64>,
    #[serde(default)]
    pub integer: bool,
    // enum-only
    #[serde(default)]
    pub options: Vec<EnumOption>,
    #[serde(default)]
    pub multiple: bool,
    // file/files-only
    #[serde(default)]
    pub accept: Vec<String>,
    // date-only
    pub min_date: Option<String>,
    pub max_date: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OutputType {
    File,
    Directory,
    Text,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputSpec {
    pub id: String,
    pub label: Option<String>,
    pub description: Option<String>,
    #[serde(rename = "type")]
    pub ty: OutputType,
    #[serde(default)]
    pub save: bool,
    pub suggested: Option<String>,
    #[serde(default)]
    pub accept: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sandbox {
    /// Base Docker image (pulled at install time, layered into installed image).
    pub image: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub name: String,
    pub id: Option<String>,
    pub description: Option<String>,
    pub version: Option<String>,
    pub icon: Option<String>,
    pub category: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub readme: Option<String>,
    /// When set, the script runs inside Docker. The only sandbox-specific manifest
    /// surface is the image; everything else (entry, lifecycle, inputs, outputs)
    /// works the same way it does on the host.
    pub sandbox: Option<Sandbox>,
    pub entry: EntrySpec,
    pub platform: Option<Platform>,
    pub lifecycle: Option<Lifecycle>,
    #[serde(default)]
    pub inputs: Vec<InputSpec>,
    #[serde(default)]
    pub outputs: Vec<OutputSpec>,
}

impl Manifest {
    /// Resolve entry/lifecycle taking platform overrides into account.
    pub fn effective_entry(&self) -> EntrySpec {
        let override_entry = self.platform.as_ref().and_then(|p| {
            #[cfg(target_os = "windows")]
            {
                p.windows.as_ref().and_then(|o| o.entry.clone())
            }
            #[cfg(target_os = "macos")]
            {
                p.macos.as_ref().and_then(|o| o.entry.clone())
            }
            #[cfg(not(any(target_os = "windows", target_os = "macos")))]
            {
                let _ = p;
                None
            }
        });
        override_entry.unwrap_or_else(|| self.entry.clone())
    }

    pub fn effective_lifecycle(&self) -> Lifecycle {
        let from_platform: Option<Lifecycle> = self.platform.as_ref().and_then(|p| {
            #[cfg(target_os = "windows")]
            {
                p.windows.as_ref().and_then(|o| o.lifecycle.clone())
            }
            #[cfg(target_os = "macos")]
            {
                p.macos.as_ref().and_then(|o| o.lifecycle.clone())
            }
            #[cfg(not(any(target_os = "windows", target_os = "macos")))]
            {
                let _ = p;
                None
            }
        });
        let base = self.lifecycle.clone().unwrap_or_default();
        match from_platform {
            None => base,
            Some(over) => Lifecycle {
                install: over.install.or(base.install),
                uninstall: over.uninstall.or(base.uninstall),
                pre_run: over.pre_run.or(base.pre_run),
            },
        }
    }
}
