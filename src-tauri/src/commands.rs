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
    let runnerx_home = crate::config::home_dir()
        .ok_or_else(|| RxError::Other("could not resolve home directory".into()))?;
    let path = runnerx_home.join("scripts");
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

/// Read the script's distribution files (manifest.yaml + the `files` list)
/// for the AI edit flow. Errors out if the manifest doesn't declare `files`
/// — the AI edit button is gated on that field, so reaching here without it
/// is a misuse.
///
/// Per-file (64 KB) and total (256 KB) byte caps apply to keep prompt size
/// bounded; oversized files are silently skipped.
#[tauri::command]
pub fn read_script_files(dir: String) -> Result<Vec<ScriptFileEntry>> {
    const MAX_TOTAL_BYTES: u64 = 256 * 1024;
    const MAX_FILE_BYTES: u64 = 64 * 1024;
    let root = PathBuf::from(&dir);
    if !root.is_dir() {
        return Err(RxError::Other(format!("脚本目录不存在：{}", root.display())));
    }
    let whitelist = read_files_field(&root)
        .ok_or_else(|| RxError::Other("manifest 没有声明 `files` 字段，无法启用 AI 修改".into()))?;
    read_whitelisted(&root, &whitelist, MAX_FILE_BYTES, MAX_TOTAL_BYTES)
}

/// Parse the manifest at `root/manifest.{yaml,yml}` and return its `files`
/// field. Returns `None` if the manifest is missing/unreadable/unparseable
/// or the field is absent.
fn read_files_field(root: &std::path::Path) -> Option<Vec<String>> {
    for name in ["manifest.yaml", "manifest.yml"] {
        let p = root.join(name);
        if !p.is_file() { continue; }
        let raw = std::fs::read_to_string(&p).ok()?;
        let manifest: Manifest = serde_yaml::from_str(&raw).ok()?;
        return manifest.files;
    }
    None
}

/// Read each whitelisted relative path under `root`. Always prepends
/// `manifest.yaml` (or `.yml`) so the AI flow's required declaration is
/// guaranteed present even if the author didn't list it. Skips paths that
/// don't exist, escape the root, or blow past size caps.
fn read_whitelisted(
    root: &std::path::Path,
    whitelist: &[String],
    max_file: u64,
    max_total: u64,
) -> Result<Vec<ScriptFileEntry>> {
    let mut paths: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    let push_unique = |paths: &mut Vec<String>, seen: &mut std::collections::HashSet<String>, p: String| {
        if seen.insert(p.clone()) {
            paths.push(p);
        }
    };
    for name in ["manifest.yaml", "manifest.yml"] {
        if root.join(name).is_file() {
            push_unique(&mut paths, &mut seen, name.to_string());
            break;
        }
    }
    for raw in whitelist {
        let trimmed = raw.trim().trim_start_matches("./");
        if trimmed.is_empty() { continue; }
        // Reject absolute paths and any traversal. Forward slashes only.
        let pb = PathBuf::from(trimmed);
        if pb.is_absolute() { continue; }
        let mut safe = true;
        let mut norm = String::new();
        for comp in pb.components() {
            match comp {
                Component::Normal(s) => {
                    if !norm.is_empty() { norm.push('/'); }
                    norm.push_str(&s.to_string_lossy());
                }
                _ => { safe = false; break; }
            }
        }
        if !safe || norm.is_empty() { continue; }
        push_unique(&mut paths, &mut seen, norm);
    }

    let mut entries: Vec<ScriptFileEntry> = Vec::new();
    let mut total: u64 = 0;
    for rel in &paths {
        let abs = root.join(rel);
        let metadata = match abs.metadata() {
            Ok(m) if m.is_file() => m,
            _ => continue,
        };
        let size = metadata.len();
        if size > max_file { continue; }
        if total + size > max_total { break; }
        let content = match std::fs::read_to_string(&abs) {
            Ok(s) => s,
            Err(_) => continue,
        };
        total += size;
        let executable = is_executable(&metadata, rel);
        entries.push(ScriptFileEntry { path: rel.clone(), content, executable });
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
pub fn read_dotenv(dir: String) -> Result<String> {
    let path = PathBuf::from(dir).join(".env");
    if path.is_file() {
        Ok(std::fs::read_to_string(&path)?)
    } else {
        Ok(String::new())
    }
}

#[tauri::command]
pub fn write_dotenv(dir: String, content: String) -> Result<()> {
    let path = PathBuf::from(dir).join(".env");
    Ok(std::fs::write(&path, content.as_bytes())?)
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
    // 仅在 Unix 上用于 0o755 标记；Windows 没有 mode 概念，故此字段在 Windows 编译里
    // 不会被读到，直接 #[allow(dead_code)] 抑制告警。
    #[serde(default)]
    #[cfg_attr(not(unix), allow(dead_code))]
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
