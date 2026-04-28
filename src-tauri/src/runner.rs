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
    let entry = manifest.effective_entry();
    let cwd = resolve_cwd(&script_dir, entry.cwd.as_deref());

    let stdin_payload = if entry.args_mode == ArgsMode::StdinJson {
        Some(json!({ "inputs": inputs, "outputs": outputs }).to_string())
    } else {
        None
    };

    let mut command = build_command(&entry, &script_dir, &inputs, &outputs, &manifest.inputs)?;
    spawn_event_stream(app, state, &mut command, &cwd, stdin_payload, RunMode::Script, None).await
}

pub async fn spawn_install(
    app: AppHandle,
    state: Arc<RunnerState>,
    manifest: Manifest,
    script_dir: PathBuf,
) -> Result<String> {
    let lifecycle = manifest.effective_lifecycle();
    let install = lifecycle
        .install
        .ok_or_else(|| RxError::Other("no install lifecycle defined".into()))?;
    let cwd = resolve_cwd(&script_dir, install.cwd.as_deref());
    let mut command = build_base_command(&install, &script_dir);
    let marker = crate::scanner::installed_marker_path(&script_dir);
    let on_exit: BoxedExitHook = Box::new(move |code, cancelled| {
        if !cancelled && code == Some(0) {
            let _ = std::fs::write(&marker, b"installed by runnerx\n");
        }
    });
    spawn_event_stream(app, state, &mut command, &cwd, None, RunMode::Install, Some(on_exit)).await
}

pub async fn spawn_uninstall(
    app: AppHandle,
    state: Arc<RunnerState>,
    manifest: Manifest,
    script_dir: PathBuf,
) -> Result<String> {
    let lifecycle = manifest.effective_lifecycle();
    let uninstall = lifecycle
        .uninstall
        .ok_or_else(|| RxError::Other("no uninstall lifecycle defined".into()))?;
    let cwd = resolve_cwd(&script_dir, uninstall.cwd.as_deref());
    let mut command = build_base_command(&uninstall, &script_dir);
    let marker = crate::scanner::installed_marker_path(&script_dir);
    let on_exit: BoxedExitHook = Box::new(move |code, cancelled| {
        if !cancelled && code == Some(0) {
            let _ = std::fs::remove_file(&marker);
        }
    });
    spawn_event_stream(app, state, &mut command, &cwd, None, RunMode::Uninstall, Some(on_exit)).await
}

pub async fn run_pre_run_sync(manifest: &Manifest, script_dir: &Path) -> Result<()> {
    let lifecycle = manifest.effective_lifecycle();
    let Some(spec) = lifecycle.pre_run else { return Ok(()); };
    let cwd = resolve_cwd(script_dir, spec.cwd.as_deref());
    let mut cmd = build_base_command(&spec, script_dir);
    cmd.current_dir(&cwd).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    let output = cmd.output().await.map_err(|e| RxError::Other(format!("preRun failed to start: {e}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(RxError::Other(format!("preRun failed: {stderr}")));
    }
    Ok(())
}

type BoxedExitHook = Box<dyn FnOnce(Option<i32>, bool) + Send + 'static>;

async fn spawn_event_stream(
    app: AppHandle,
    state: Arc<RunnerState>,
    command: &mut Command,
    cwd: &Path,
    stdin_payload: Option<String>,
    mode: RunMode,
    on_exit: Option<BoxedExitHook>,
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

    let run_id = Uuid::new_v4().to_string();
    let (kill_tx, mut kill_rx) = tokio::sync::mpsc::channel::<()>(1);
    {
        let mut guard = state.active.lock().await;
        *guard = Some(ActiveRun { id: run_id.clone(), kill_tx });
    }

    let mut child = command.spawn().map_err(|e| {
        RxError::Other(format!("spawn failed: {e}"))
    })?;
    let stdout = child.stdout.take().ok_or_else(|| RxError::Other("no stdout".into()))?;
    let stderr = child.stderr.take().ok_or_else(|| RxError::Other("no stderr".into()))?;

    if let Some(payload) = stdin_payload {
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(payload.as_bytes()).await;
            let _ = stdin.shutdown().await;
        }
    }

    let _ = app.emit(EVENT_RUN, RunEvent::Started { run_id: run_id.clone(), mode });

    let app_for_out = app.clone();
    let id_for_out = run_id.clone();
    let stdout_task = tokio::spawn(async move {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            emit_line(&app_for_out, &id_for_out, &line, true);
        }
    });

    let app_for_err = app.clone();
    let id_for_err = run_id.clone();
    let stderr_task = tokio::spawn(async move {
        let reader = BufReader::new(stderr);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            emit_line(&app_for_err, &id_for_err, &line, false);
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

fn emit_line(app: &AppHandle, run_id: &str, line: &str, is_stdout: bool) {
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
            ("result", Some(v)) => {
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
                command.env(format!("RUNNERX_OUT_{}", key.to_uppercase()), value_to_string(value, None));
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
