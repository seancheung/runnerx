use std::path::{Component, PathBuf};
use std::sync::Arc;

use crate::error::{Result, RxError};
use crate::manifest::Manifest;
use crate::runner::{self, RunRequest, RunnerState};
use crate::scanner::{self, ScanError, ScriptInfo};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub scripts: Vec<ScriptInfo>,
    pub errors: Vec<ScanError>,
}

#[tauri::command]
pub fn list_scripts(root: String) -> ScanResult {
    let path = PathBuf::from(root);
    let (scripts, errors) = scanner::scan_root(&path);
    ScanResult { scripts, errors }
}

#[tauri::command]
pub fn default_scripts_root() -> Result<String> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .ok_or_else(|| RxError::Other("could not resolve home directory".into()))?;
    let path = PathBuf::from(home).join(".runnerx").join("scripts");
    if !path.exists() {
        std::fs::create_dir_all(&path)?;
    }
    Ok(path.display().to_string())
}

#[tauri::command]
pub fn read_script(dir: String) -> Result<ScriptInfo> {
    scanner::load_script(&PathBuf::from(dir))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptFileEntry {
    pub path: String,
    pub content: String,
    pub executable: bool,
}

/// Read text-like files inside a script directory for AI editing context.
/// Skips binary files (icons, archives), oversized files, and the install
/// state marker. Paths are relative to `dir`, using forward slashes.
#[tauri::command]
pub fn read_script_files(dir: String) -> Result<Vec<ScriptFileEntry>> {
    const MAX_TOTAL_BYTES: u64 = 256 * 1024;
    const MAX_FILE_BYTES: u64 = 64 * 1024;
    const SKIP_EXT: &[&str] = &[
        "png", "jpg", "jpeg", "gif", "webp", "ico", "icns", "bmp",
        "zip", "tar", "gz", "tgz", "xz", "bz2", "7z",
        "exe", "dll", "so", "dylib", "bin",
        "pdf", "mp3", "mp4", "mov", "wav",
    ];
    let root = PathBuf::from(&dir);
    if !root.is_dir() {
        return Err(RxError::Other(format!("脚本目录不存在：{}", root.display())));
    }
    let mut entries: Vec<ScriptFileEntry> = Vec::new();
    let mut total: u64 = 0;
    let mut stack: Vec<PathBuf> = vec![root.clone()];
    while let Some(current) = stack.pop() {
        let read = match std::fs::read_dir(&current) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for child in read.flatten() {
            let abs = child.path();
            let name = child.file_name();
            let name_str = name.to_string_lossy();
            // Skip hidden entries (e.g. .git, .DS_Store, .runnerx-installed).
            if name_str.starts_with('.') {
                continue;
            }
            let ft = match child.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if ft.is_dir() {
                stack.push(abs);
                continue;
            }
            if !ft.is_file() {
                continue;
            }
            let ext = abs.extension().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase();
            if !ext.is_empty() && SKIP_EXT.iter().any(|x| *x == ext.as_str()) {
                continue;
            }
            let metadata = match abs.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let size = metadata.len();
            if size > MAX_FILE_BYTES {
                continue;
            }
            if total + size > MAX_TOTAL_BYTES {
                stack.clear();
                break;
            }
            let content = match std::fs::read_to_string(&abs) {
                Ok(s) => s,
                Err(_) => continue, // not utf-8 / binary
            };
            let rel = match abs.strip_prefix(&root) {
                Ok(r) => r,
                Err(_) => continue,
            };
            let rel_str = rel.components().filter_map(|c| match c {
                Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
                _ => None,
            }).collect::<Vec<_>>().join("/");
            if rel_str.is_empty() {
                continue;
            }
            let executable = is_executable(&metadata, &rel_str);
            total += size;
            entries.push(ScriptFileEntry { path: rel_str, content, executable });
        }
    }
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(entries)
}

#[cfg(unix)]
fn is_executable(meta: &std::fs::Metadata, _rel: &str) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable(_meta: &std::fs::Metadata, rel: &str) -> bool {
    let lower = rel.to_ascii_lowercase();
    lower.ends_with(".sh") || lower.ends_with(".bash")
        || lower.ends_with(".py") || lower.ends_with(".rb") || lower.ends_with(".pl")
}

#[tauri::command]
pub fn read_readme(path: String) -> Result<String> {
    Ok(std::fs::read_to_string(&path)?)
}

#[tauri::command]
pub fn mark_uninstalled(dir: String) -> Result<()> {
    scanner::clear_install_state(&PathBuf::from(dir))
}

#[tauri::command]
pub async fn run_script(
    app: AppHandle,
    state: State<'_, Arc<RunnerState>>,
    request: RunRequest,
) -> Result<String> {
    let dir = PathBuf::from(&request.script_dir);
    let info = scanner::load_script(&dir)?;
    runner::run_pre_run_sync(&info.manifest, &dir).await?;
    runner::spawn_run(
        app,
        Arc::clone(&state),
        info.manifest,
        dir,
        request.inputs,
        request.outputs,
    )
    .await
}

#[tauri::command]
pub async fn run_install(
    app: AppHandle,
    state: State<'_, Arc<RunnerState>>,
    dir: String,
) -> Result<String> {
    let path = PathBuf::from(&dir);
    let info = scanner::load_script(&path)?;
    let is_sandbox = info.manifest.sandbox.is_some();
    let block = info.manifest.current_block();
    if block.is_none() {
        return Err(RxError::Other("script does not support the current platform".into()));
    }
    if !is_sandbox && block.and_then(|b| b.install.as_ref()).is_none() {
        return Err(RxError::Other("script has no install command for this platform".into()));
    }
    runner::spawn_install(app, Arc::clone(&state), info.manifest, path).await
}

async fn do_uninstall(
    app: AppHandle,
    state: State<'_, Arc<RunnerState>>,
    dir: String,
    also_remove_base: bool,
) -> Result<String> {
    let path = PathBuf::from(&dir);
    let info = scanner::load_script(&path)?;
    let is_sandbox = info.manifest.sandbox.is_some();
    let block = info.manifest.current_block();
    if block.is_none() {
        return Err(RxError::Other("script does not support the current platform".into()));
    }
    if !is_sandbox && block.and_then(|b| b.uninstall.as_ref()).is_none() {
        return Err(RxError::Other("script has no uninstall command for this platform".into()));
    }
    runner::spawn_uninstall(
        app,
        Arc::clone(&state),
        info.manifest,
        path,
        also_remove_base,
    )
    .await
}

#[tauri::command]
pub async fn run_uninstall(
    app: AppHandle,
    state: State<'_, Arc<RunnerState>>,
    dir: String,
) -> Result<String> {
    do_uninstall(app, state, dir, false).await
}

#[tauri::command]
pub async fn run_uninstall_with_base(
    app: AppHandle,
    state: State<'_, Arc<RunnerState>>,
    dir: String,
) -> Result<String> {
    do_uninstall(app, state, dir, true).await
}

#[tauri::command]
pub async fn cancel_run(state: State<'_, Arc<RunnerState>>, run_id: String) -> Result<()> {
    runner::cancel(&state, &run_id).await
}

#[tauri::command]
pub async fn current_run(state: State<'_, Arc<RunnerState>>) -> Result<Option<String>> {
    Ok(runner::current_run_id(&state).await)
}

#[tauri::command]
pub fn manifest_schema() -> &'static str {
    include_str!("../../schema/manifest.schema.json")
}

#[tauri::command]
pub fn get_config() -> crate::config::AppConfig {
    crate::config::load()
}

#[tauri::command]
pub fn set_config(config: crate::config::AppConfig) -> Result<()> {
    crate::config::save(&config).map_err(|e| RxError::Other(format!("save config: {e}")))
}

#[tauri::command]
pub fn validate_manifest(yaml: String) -> Result<Manifest> {
    Ok(serde_yaml::from_str(&yaml)?)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteFile {
    pub path: String,
    pub content: String,
    #[serde(default)]
    pub executable: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteScriptRequest {
    pub root: String,
    pub script_id: String,
    pub files: Vec<WriteFile>,
    #[serde(default)]
    pub overwrite: bool,
}

/// Write an AI-generated script into <root>/<scriptId>/. The id and each file
/// path are sanitized to forbid traversal; on Unix files marked `executable`
/// get 0755.
#[tauri::command]
pub fn write_script_files(request: WriteScriptRequest) -> Result<String> {
    let id = request.script_id.trim();
    if id.is_empty()
        || id.starts_with('.')
        || id.contains(['/', '\\', '\0'])
        || id == "." || id == ".."
    {
        return Err(RxError::Other(format!("非法脚本 id：{id}")));
    }
    let root = PathBuf::from(&request.root);
    if !root.is_dir() {
        return Err(RxError::Other(format!("脚本根目录不存在：{}", root.display())));
    }
    let target = root.join(id);
    if target.exists() && !request.overwrite {
        return Err(RxError::Other(format!("目录已存在：{}", target.display())));
    }
    std::fs::create_dir_all(&target)?;

    for file in &request.files {
        let rel = PathBuf::from(&file.path);
        if rel.is_absolute()
            || rel.components().any(|c| matches!(c, Component::ParentDir))
            || file.path.contains('\0')
        {
            return Err(RxError::Other(format!("非法文件路径：{}", file.path)));
        }
        let full = target.join(&rel);
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&full, &file.content)?;
        #[cfg(unix)]
        if file.executable {
            use std::os::unix::fs::PermissionsExt;
            let perms = std::fs::Permissions::from_mode(0o755);
            std::fs::set_permissions(&full, perms)?;
        }
    }
    Ok(target.display().to_string())
}
