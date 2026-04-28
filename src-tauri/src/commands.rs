use std::path::PathBuf;
use std::sync::Arc;

use crate::error::{Result, RxError};
use crate::manifest::Manifest;
use crate::runner::{self, RunRequest, RunnerState};
use crate::scanner::{self, ScanError, ScriptInfo};
use serde::Serialize;
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
    if info.manifest.effective_lifecycle().install.is_none() {
        return Err(RxError::Other("script has no install lifecycle".into()));
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
    if !is_sandbox && info.manifest.effective_lifecycle().uninstall.is_none() {
        return Err(RxError::Other("script has no uninstall lifecycle".into()));
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
