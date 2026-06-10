use crate::error::{Result, RxError};
use crate::manifest::{ArgsMode, CommandSpec, EntrySpec, InputSpec, InputType, Manifest};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex;
use uuid::Uuid;

pub const EVENT_RUN: &str = "run-event";
const PROTOCOL_PREFIX: &str = "@@runnerx ";

/// Suppress the console window that Windows would otherwise pop up when we
/// launch a console-subsystem child (cmd.exe, sh, docker, native binaries).
/// No-op on non-Windows hosts.
pub(crate) fn hide_console_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

/// Put the child into its own process group on Unix. This is what makes
/// "cancel" actually stop subprocesses spawned with `&` from inside a script
/// — without it, killing the wrapper shell leaves orphans (ffmpeg, python
/// background tasks, ...) running under init.
fn set_process_group(cmd: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.as_std_mut().process_group(0);
    }
    #[cfg(not(unix))]
    {
        let _ = cmd;
    }
}

#[cfg(unix)]
fn kill_process_group(pid: u32) {
    // Negative pid means "process group with this leader". SIGKILL on the
    // group reaches every descendant in the same pgid, which our
    // process_group(0) call put them in.
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
}

#[cfg(not(unix))]
fn kill_process_group(_pid: u32) {
    // On Windows we rely on tokio's `child.kill()` (TerminateProcess) plus
    // sandbox cleanup; a true process-tree kill would need Job Objects.
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RunMode {
    Script,
    Install,
    Uninstall,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(tag = "kind")]
pub enum RunEvent {
    Started { run_id: String, mode: RunMode },
    Progress { run_id: String, value: f64, message: Option<String> },
    Log { run_id: String, level: String, message: String },
    Stdout { run_id: String, line: String },
    Stderr { run_id: String, line: String },
    Result { run_id: String, payload: Value },
    Exit { run_id: String, code: Option<i32>, cancelled: bool, mode: RunMode },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRequest {
    pub script_dir: String,
    pub inputs: HashMap<String, Value>,
    #[serde(default)]
    pub outputs: HashMap<String, Value>,
}

struct ActiveRun {
    id: String,
    kill_tx: tokio::sync::mpsc::Sender<()>,
}

#[derive(Default)]
pub struct RunnerState {
    active: Mutex<Option<ActiveRun>>,
}

impl RunnerState {
    pub fn new() -> Self { Self::default() }
}

pub async fn current_run_id(state: &RunnerState) -> Option<String> {
    state.active.lock().await.as_ref().map(|r| r.id.clone())
}

pub async fn cancel(state: &RunnerState, run_id: &str) -> Result<()> {
    let guard = state.active.lock().await;
    if let Some(active) = guard.as_ref() {
        if active.id == run_id {
            let _ = active.kill_tx.send(()).await;
        }
    }
    drop(guard);
    // Best-effort: also kill any sandbox container that follows our naming convention.
    // Cheap: a docker call when no container exists just returns non-zero, no harm.
    crate::sandbox::cancel_container(run_id).await;
    Ok(())
}

pub async fn spawn_run(
    app: AppHandle,
    state: Arc<RunnerState>,
    manifest: Manifest,
    script_dir: PathBuf,
    inputs: HashMap<String, Value>,
    outputs: HashMap<String, Value>,
) -> Result<String> {
    if manifest.sandbox.is_some() {
        return crate::sandbox::spawn_sandbox_run(app, state, manifest, script_dir, inputs, outputs).await;
    }

    let block = manifest
        .current_block()
        .ok_or_else(|| RxError::Other("script does not support the current platform".into()))?;
    let entry = block.entry.clone();
    let cwd = resolve_cwd(&script_dir, entry.cwd.as_deref());

    let stdin_payload = if entry.args_mode == ArgsMode::StdinJson {
        Some(json!({ "inputs": inputs, "outputs": outputs }).to_string())
    } else {
        None
    };

    let mut command = build_command(&entry, &script_dir, &inputs, &outputs, &manifest.inputs)?;
    apply_dotenv(&mut command, &script_dir);
    spawn_event_stream(app, state, &mut command, &cwd, stdin_payload, RunMode::Script, None, None, None).await
}

pub async fn spawn_install(
    app: AppHandle,
    state: Arc<RunnerState>,
    manifest: Manifest,
    script_dir: PathBuf,
) -> Result<String> {
    if manifest.sandbox.is_some() {
        return crate::sandbox::spawn_sandbox_install(app, state, manifest, script_dir).await;
    }

    let block = manifest
        .current_block()
        .ok_or_else(|| RxError::Other("script does not support the current platform".into()))?;
    let install = block
        .install
        .clone()
        .ok_or_else(|| RxError::Other("no install command defined for this platform".into()))?;
    let cwd = resolve_cwd(&script_dir, install.cwd.as_deref());
    let mut command = build_base_command(&install, &script_dir);
    apply_dotenv(&mut command, &script_dir);
    let dir_clone = script_dir.clone();
    let on_exit: BoxedExitHook = Box::new(move |code, cancelled| {
        if !cancelled && code == Some(0) {
            let state = crate::scanner::InstallState {
                version: 1,
                kind: crate::scanner::InstallKind::Host,
                image: None,
                base_image: None,
                installed_at: Some(crate::scanner::current_iso_timestamp()),
            };
            let _ = crate::scanner::write_install_state(&dir_clone, &state);
        }
    });
    spawn_event_stream(app, state, &mut command, &cwd, None, RunMode::Install, Some(on_exit), None, None).await
}

pub async fn spawn_uninstall(
    app: AppHandle,
    state: Arc<RunnerState>,
    manifest: Manifest,
    script_dir: PathBuf,
    also_remove_base: bool,
) -> Result<String> {
    if manifest.sandbox.is_some() {
        return crate::sandbox::spawn_sandbox_uninstall(app, state, manifest, script_dir, also_remove_base).await;
    }

    let block = manifest
        .current_block()
        .ok_or_else(|| RxError::Other("script does not support the current platform".into()))?;
    let uninstall = block
        .uninstall
        .clone()
        .ok_or_else(|| RxError::Other("no uninstall command defined for this platform".into()))?;
    let cwd = resolve_cwd(&script_dir, uninstall.cwd.as_deref());
    let mut command = build_base_command(&uninstall, &script_dir);
    apply_dotenv(&mut command, &script_dir);
    let dir_clone = script_dir.clone();
    let on_exit: BoxedExitHook = Box::new(move |code, cancelled| {
        if !cancelled && code == Some(0) {
            let _ = crate::scanner::clear_install_state(&dir_clone);
        }
    });
    spawn_event_stream(app, state, &mut command, &cwd, None, RunMode::Uninstall, Some(on_exit), None, None).await
}

pub async fn run_pre_run_sync(manifest: &Manifest, script_dir: &Path) -> Result<()> {
    let Some(block) = manifest.current_block() else { return Ok(()); };
    let Some(spec) = block.pre_run.clone() else { return Ok(()); };
    let cwd = resolve_cwd(script_dir, spec.cwd.as_deref());
    let mut cmd = build_base_command(&spec, script_dir);
    apply_dotenv(&mut cmd, script_dir);
    cmd.current_dir(&cwd).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    let output = cmd.output().await.map_err(|e| RxError::Other(format!("preRun failed to start: {e}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(RxError::Other(format!("preRun failed: {stderr}")));
    }
    Ok(())
}

pub(crate) type BoxedExitHook = Box<dyn FnOnce(Option<i32>, bool) + Send + 'static>;

pub(crate) async fn spawn_event_stream(
    app: AppHandle,
    state: Arc<RunnerState>,
    command: &mut Command,
    cwd: &Path,
    stdin_payload: Option<String>,
    mode: RunMode,
    on_exit: Option<BoxedExitHook>,
    predetermined_run_id: Option<String>,
    // container_path -> host_path translation for `result` payloads emitted
    // by sandboxed scripts; the script reports container-side paths because
    // that's what it sees, but the frontend needs host paths to reveal the file.
    result_path_map: Option<HashMap<String, String>>,
) -> Result<String> {
    {
        let guard = state.active.lock().await;
        if guard.is_some() {
            return Err(RxError::Other("another run is already in progress".into()));
        }
    }

    command
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if stdin_payload.is_some() {
        command.stdin(Stdio::piped());
    } else {
        command.stdin(Stdio::null());
    }
    hide_console_window(command);
    set_process_group(command);

    let run_id = predetermined_run_id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let (kill_tx, mut kill_rx) = tokio::sync::mpsc::channel::<()>(1);
    {
        let mut guard = state.active.lock().await;
        *guard = Some(ActiveRun { id: run_id.clone(), kill_tx });
    }

    let mut child = command.spawn().map_err(|e| {
        RxError::Other(format!("spawn failed: {e}"))
    })?;
    let child_pid = child.id();
    let stdout = child.stdout.take().ok_or_else(|| RxError::Other("no stdout".into()))?;
    let stderr = child.stderr.take().ok_or_else(|| RxError::Other("no stderr".into()))?;

    if let Some(payload) = stdin_payload {
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(payload.as_bytes()).await;
            let _ = stdin.shutdown().await;
        }
    }

    let _ = app.emit(EVENT_RUN, RunEvent::Started { run_id: run_id.clone(), mode });

    let path_map = Arc::new(result_path_map.unwrap_or_default());
    let app_for_out = app.clone();
    let id_for_out = run_id.clone();
    let map_for_out = path_map.clone();
    let stdout_task = tokio::spawn(async move {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            emit_line(&app_for_out, &id_for_out, &line, true, &map_for_out);
        }
    });

    let app_for_err = app.clone();
    let id_for_err = run_id.clone();
    let map_for_err = path_map.clone();
    let stderr_task = tokio::spawn(async move {
        let reader = BufReader::new(stderr);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            emit_line(&app_for_err, &id_for_err, &line, false, &map_for_err);
        }
    });

    let app_for_wait = app.clone();
    let state_for_wait = state.clone();
    let id_for_wait = run_id.clone();
    tokio::spawn(async move {
        let mut cancelled = false;
        let exit_status = tokio::select! {
            biased;
            _ = kill_rx.recv() => {
                cancelled = true;
                if let Some(pid) = child_pid {
                    kill_process_group(pid);
                }
                let _ = child.kill().await;
                child.wait().await
            }
            res = child.wait() => res,
        };
        let _ = stdout_task.await;
        let _ = stderr_task.await;

        let code = exit_status.ok().and_then(|s| s.code());
        if let Some(hook) = on_exit {
            hook(code, cancelled);
        }
        let _ = app_for_wait.emit(
            EVENT_RUN,
            RunEvent::Exit { run_id: id_for_wait.clone(), code, cancelled, mode },
        );

        let mut guard = state_for_wait.active.lock().await;
        if guard.as_ref().map(|r| r.id == id_for_wait).unwrap_or(false) {
            *guard = None;
        }
    });

    Ok(run_id)
}

fn emit_line(
    app: &AppHandle,
    run_id: &str,
    line: &str,
    is_stdout: bool,
    path_map: &HashMap<String, String>,
) {
    if let Some(rest) = line.strip_prefix(PROTOCOL_PREFIX) {
        let mut split = rest.splitn(2, char::is_whitespace);
        let kind = split.next().unwrap_or("").trim();
        let payload = split.next().unwrap_or("").trim();
        let parsed: Option<Value> = serde_json::from_str(payload).ok();
        match (kind, parsed) {
            ("progress", Some(v)) => {
                let value = v.get("value").and_then(|x| x.as_f64()).unwrap_or(0.0);
                let message = v.get("message").and_then(|x| x.as_str()).map(String::from);
                let _ = app.emit(EVENT_RUN, RunEvent::Progress { run_id: run_id.into(), value, message });
                return;
            }
            ("log", Some(v)) => {
                let level = v.get("level").and_then(|x| x.as_str()).unwrap_or("info").to_string();
                let message = v.get("message").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let _ = app.emit(EVENT_RUN, RunEvent::Log { run_id: run_id.into(), level, message });
                return;
            }
            ("result", Some(mut v)) => {
                if !path_map.is_empty() {
                    translate_result_paths(&mut v, path_map);
                }
                let _ = app.emit(EVENT_RUN, RunEvent::Result { run_id: run_id.into(), payload: v });
                return;
            }
            _ => {}
        }
    }
    let event = if is_stdout {
        RunEvent::Stdout { run_id: run_id.into(), line: line.into() }
    } else {
        RunEvent::Stderr { run_id: run_id.into(), line: line.into() }
    };
    let _ = app.emit(EVENT_RUN, event);
}

/// Replace `path` fields inside a `result` payload with their host-side
/// equivalents using the container→host map. Only top-level `path` is rewritten
/// (file/image result types). If the value isn't in the map but starts with a
/// known mount root and matches by suffix, we still try a longest-prefix match.
fn translate_result_paths(payload: &mut Value, map: &HashMap<String, String>) {
    if let Some(obj) = payload.as_object_mut() {
        if let Some(p) = obj.get("path").and_then(|v| v.as_str()).map(String::from) {
            if let Some(host) = map.get(&p) {
                obj.insert("path".into(), Value::String(host.clone()));
            } else if let Some(host) = longest_prefix_match(&p, map) {
                obj.insert("path".into(), Value::String(host));
            }
        }
    }
}

fn longest_prefix_match(container_path: &str, map: &HashMap<String, String>) -> Option<String> {
    let mut best: Option<(&String, &String)> = None;
    for (k, v) in map {
        if container_path.starts_with(k.as_str()) {
            if best.map(|(b, _)| k.len() > b.len()).unwrap_or(true) {
                best = Some((k, v));
            }
        }
    }
    best.map(|(k, host)| {
        let suffix = &container_path[k.len()..];
        format!("{host}{suffix}")
    })
}

fn resolve_cwd(script_dir: &Path, configured: Option<&str>) -> PathBuf {
    match configured {
        Some(p) => {
            let path = PathBuf::from(p);
            if path.is_absolute() { path } else { script_dir.join(path) }
        }
        None => script_dir.to_path_buf(),
    }
}

fn build_command(
    entry: &EntrySpec,
    script_dir: &Path,
    inputs: &HashMap<String, Value>,
    outputs: &HashMap<String, Value>,
    input_specs: &[InputSpec],
) -> Result<Command> {
    let cmd_spec = CommandSpec {
        command: entry.command.clone(),
        args: entry.args.clone(),
        shell: entry.shell,
        cwd: entry.cwd.clone(),
    };
    let mut command = build_base_command(&cmd_spec, script_dir);
    match entry.args_mode {
        ArgsMode::Env => {
            for (key, value) in inputs {
                let spec = input_specs.iter().find(|s| &s.id == key);
                let env_value = value_to_string(value, spec);
                command.env(format!("RUNNERX_{}", key.to_uppercase()), env_value);
            }
            for (key, value) in outputs {
                command.env(format!("RUNNERX_{}", key.to_uppercase()), value_to_string(value, None));
            }
        }
        ArgsMode::Argv => {
            for (key, value) in inputs {
                let spec = input_specs.iter().find(|s| &s.id == key);
                push_argv(&mut command, key, value, spec);
            }
            for (key, value) in outputs {
                let flag = format!("--out-{}", to_kebab(key));
                let s = value_to_string(value, None);
                if !s.is_empty() { command.arg(format!("{flag}={s}")); }
            }
        }
        ArgsMode::StdinJson => {}
    }
    Ok(command)
}

fn build_base_command(spec: &CommandSpec, script_dir: &Path) -> Command {
    let resolved = resolve_command_path(&spec.command, script_dir);
    let mut command = if spec.shell {
        if cfg!(target_os = "windows") {
            let mut c = Command::new("cmd");
            c.arg("/C").arg(&resolved);
            for a in &spec.args { c.arg(a); }
            c
        } else {
            let mut c = Command::new("sh");
            c.arg("-c");
            let joined = std::iter::once(quote_for_sh(&resolved.to_string_lossy()))
                .chain(spec.args.iter().map(|a| quote_for_sh(a)))
                .collect::<Vec<_>>()
                .join(" ");
            c.arg(joined);
            c
        }
    } else {
        let mut c = Command::new(&resolved);
        for a in &spec.args { c.arg(a); }
        c
    };
    command.kill_on_drop(true);
    hide_console_window(&mut command);
    command
}

fn quote_for_sh(s: &str) -> String {
    if s.is_empty() {
        return "''".into();
    }
    if s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '/' | ':' | '=')) {
        return s.into();
    }
    let escaped = s.replace('\'', "'\\''");
    format!("'{escaped}'")
}

fn resolve_command_path(cmd: &str, script_dir: &Path) -> PathBuf {
    if cmd.starts_with("./") || cmd.starts_with(".\\") {
        script_dir.join(&cmd[2..])
    } else if Path::new(cmd).is_absolute() {
        PathBuf::from(cmd)
    } else if cmd.contains('/') || cmd.contains('\\') {
        script_dir.join(cmd)
    } else {
        PathBuf::from(cmd)
    }
}

fn push_argv(cmd: &mut Command, key: &str, value: &Value, spec: Option<&InputSpec>) {
    let kebab = to_kebab(key);
    let flag = format!("--{kebab}");
    if let Some(s) = spec {
        if s.ty == InputType::Boolean {
            if value.as_bool().unwrap_or(false) { cmd.arg(flag); }
            return;
        }
        if s.ty == InputType::Files || (s.ty == InputType::Enum && s.multiple) {
            if let Some(arr) = value.as_array() {
                for item in arr {
                    let v = scalar_to_string(item);
                    if !v.is_empty() { cmd.arg(format!("{flag}={v}")); }
                }
                return;
            }
        }
    }
    let v = value_to_string(value, spec);
    if !v.is_empty() { cmd.arg(format!("{flag}={v}")); }
}

fn value_to_string(value: &Value, spec: Option<&InputSpec>) -> String {
    if let Some(s) = spec {
        match s.ty {
            InputType::Boolean => return value.as_bool().map(|b| if b { "1" } else { "0" }).unwrap_or("0").into(),
            InputType::Files => {
                if let Some(arr) = value.as_array() {
                    let sep = if cfg!(target_os = "windows") { ";" } else { ":" };
                    return arr.iter().map(scalar_to_string).collect::<Vec<_>>().join(sep);
                }
            }
            InputType::Enum if s.multiple => {
                if let Some(arr) = value.as_array() {
                    return arr.iter().map(scalar_to_string).collect::<Vec<_>>().join(",");
                }
            }
            InputType::Json => return value.to_string(),
            _ => {}
        }
    }
    scalar_to_string(value)
}

fn scalar_to_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => if *b { "1".into() } else { "0".into() },
        Value::Number(n) => n.to_string(),
        Value::Array(_) | Value::Object(_) => value.to_string(),
    }
}

fn to_kebab(s: &str) -> String { s.replace('_', "-").to_lowercase() }

/// Parse a `.env` file from the script directory (if it exists) and return
/// the key-value pairs.
pub(crate) fn load_dotenv(script_dir: &Path) -> Vec<(String, String)> {
    let path = script_dir.join(".env");
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    let mut pairs = Vec::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let trimmed = trimmed.strip_prefix("export ").unwrap_or(trimmed);
        if let Some((key, raw_value)) = trimmed.split_once('=') {
            let key = key.trim().to_string();
            if key.is_empty() {
                continue;
            }
            let value = raw_value.trim();
            let value = if (value.starts_with('"') && value.ends_with('"') && value.len() >= 2)
                || (value.starts_with('\'') && value.ends_with('\'') && value.len() >= 2)
            {
                value[1..value.len() - 1].to_string()
            } else {
                value.to_string()
            };
            pairs.push((key, value));
        }
    }
    pairs
}

fn apply_dotenv(command: &mut Command, script_dir: &Path) {
    for (key, value) in load_dotenv(script_dir) {
        command.env(&key, &value);
    }
}
