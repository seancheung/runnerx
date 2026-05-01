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

/// Per-platform configuration: entry plus optional lifecycle hooks (install /
/// uninstall / preRun) live side-by-side at this level. There is no separate
/// `lifecycle` wrapper — the four optional fields are siblings.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformBlock {
    pub entry: EntrySpec,
    pub install: Option<CommandSpec>,
    pub uninstall: Option<CommandSpec>,
    pub pre_run: Option<CommandSpec>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum PlatformId {
    Macos,
    Windows,
}

impl PlatformId {
    pub fn current() -> Option<Self> {
        if cfg!(target_os = "macos") {
            Some(Self::Macos)
        } else if cfg!(target_os = "windows") {
            Some(Self::Windows)
        } else {
            None
        }
    }
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputSpec {
    pub id: String,
    pub label: Option<String>,
    pub description: Option<String>,
    #[serde(rename = "type")]
    pub ty: OutputType,
    #[serde(default = "default_true")]
    pub required: bool,
    pub suggested: Option<String>,
    #[serde(default)]
    pub accept: Vec<String>,
}

fn default_true() -> bool { true }

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
    /// runnerx app version at the time the script was created. Stamped by the
    /// AI flows; preserved across edits so future runtime checks can adapt to
    /// schema/behavior drift.
    pub app_version: Option<String>,
    pub icon: Option<String>,
    pub category: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub readme: Option<String>,
    /// When set, the script runs inside Docker. The only sandbox-specific manifest
    /// surface is the image; everything else (entry, lifecycle, inputs, outputs)
    /// works the same way it does on the host.
    pub sandbox: Option<Sandbox>,

    /// Per-platform blocks. At least one of `macos` / `windows` must be present;
    /// validated by the scanner. Resolution at runtime: the block matching the
    /// current OS is used directly — there is no fallback / inheritance.
    pub macos: Option<PlatformBlock>,
    pub windows: Option<PlatformBlock>,

    #[serde(default)]
    pub inputs: Vec<InputSpec>,
    #[serde(default)]
    pub outputs: Vec<OutputSpec>,

    /// Distribution manifest — all files (relative paths) that make up this
    /// script. Mirrors npm's `package.json#files`: list every file the
    /// script ships, with `manifest.yaml` implicit (always included even if
    /// not listed). No glob support — list each path literally.
    ///
    /// Required for AI features: the AI edit / create flows use this list
    /// as their context window. Scripts without `files` declared have the
    /// AI edit button disabled.
    pub files: Option<Vec<String>>,
}

impl Manifest {
    /// Block for the OS we're running on. None means "this manifest doesn't
    /// support the current platform" — callers should refuse to run.
    pub fn current_block(&self) -> Option<&PlatformBlock> {
        match PlatformId::current()? {
            PlatformId::Macos => self.macos.as_ref(),
            PlatformId::Windows => self.windows.as_ref(),
        }
    }

    /// All platform ids this manifest declares a block for. Used by the UI
    /// to flag multi-platform scripts and to indicate when a script can't run
    /// on the current OS.
    pub fn supported_platforms(&self) -> Vec<PlatformId> {
        let mut out = Vec::new();
        if self.macos.is_some() {
            out.push(PlatformId::Macos);
        }
        if self.windows.is_some() {
            out.push(PlatformId::Windows);
        }
        out
    }
}
