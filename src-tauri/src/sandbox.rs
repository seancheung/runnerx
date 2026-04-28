//! Sandbox mode: run scripts inside a Docker container.
//!
//! Lifecycle:
//!   install   = `docker pull` base + `docker run -d` a sleep container, copy script
//!               source into /runnerx/work, exec the user's install command, then
//!               `docker commit` the container into runnerx-script-<id>:installed.
//!   run       = `docker run --rm` a fresh container from the installed image,
//!               mount input files (read-only), mount an output staging dir,
//!               translate paths to container-side, run entry under sh -c.
//!   uninstall = `docker rmi` the installed image, optionally also the base image,
//!               and (if user defined one) run their uninstall script in a temp
//!               container first.
//!
//! Cancel works via `docker rm -f <container_name>`, which kills any process
//! inside the container; the host wrapper script's child also dies as a side
//! effect.

use crate::error::{Result, RxError};
use crate::manifest::{ArgsMode, InputType, Manifest};
use crate::runner::{spawn_event_stream, BoxedExitHook, RunMode, RunnerState};
use crate::scanner::{self, InstallKind, InstallState};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::AppHandle;
use tokio::process::Command;
use uuid::Uuid;

const SCRIPT_SRC_DIR: &str = "/runnerx/script-src";
const WORK_DIR: &str = "/runnerx/work";
const INPUT_DIR: &str = "/runnerx/in";
const OUTPUT_DIR: &str = "/runnerx/out";

/// Container name from a runId. We strip dashes so the name stays under docker's
/// 63-char limit and doesn't collide with their `--filter name=` semantics.
pub fn container_name(run_id: &str) -> String {
    format!("runnerx-{}", run_id.replace('-', ""))
}

/// Image ref produced by `docker commit`. Lowercased because docker image names
/// must be lowercase.
fn installed_image_ref(script_id: &str) -> String {
    let safe: String = script_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c.to_ascii_lowercase() } else { '-' })
        .collect();
    format!("runnerx-script-{safe}:installed")
}

/// Best-effort cleanup: docker rm -f the well-known container name. Always
/// returns Ok; failures (no such container, daemon down) are silent.
pub async fn cancel_container(run_id: &str) {
    let name = container_name(run_id);
    let mut cmd = Command::new("docker");
    cmd.args(["rm", "-f", &name]);
    crate::runner::hide_console_window(&mut cmd);
    let _ = cmd.output().await;
}

fn shell_quote(s: &str) -> String {
    if s.is_empty() {
        return "''".into();
    }
    if s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '/' | ':' | '=' | '+' | ',' | '@')) {
        return s.into();
    }
    let escaped = s.replace('\'', "'\\''");
    format!("'{escaped}'")
}

fn derive_script_id(manifest: &Manifest, script_dir: &Path) -> Result<String> {
    Ok(manifest
        .id
        .clone()
        .or_else(|| script_dir.file_name().and_then(|n| n.to_str()).map(String::from))
        .ok_or_else(|| RxError::Other("cannot derive script id".into()))?)
}

// =====================================================================
// Install
// =====================================================================

pub async fn spawn_sandbox_install(
    app: AppHandle,
    state: Arc<RunnerState>,
    manifest: Manifest,
    script_dir: PathBuf,
) -> Result<String> {
    let sandbox = manifest
        .sandbox
        .clone()
        .ok_or_else(|| RxError::Other("manifest has no sandbox config".into()))?;
    let base_image = sandbox.image;
    let script_id = derive_script_id(&manifest, &script_dir)?;
    let installed_ref = installed_image_ref(&script_id);

    let run_id = Uuid::new_v4().to_string();
    let cname = container_name(&run_id);

    // User's install lifecycle (if any) runs inside the container at WORK_DIR.
    let lifecycle = manifest.effective_lifecycle();
    let install_step = match lifecycle.install {
        Some(c) => {
            let cmd_line = std::iter::once(c.command.clone())
                .chain(c.args.into_iter())
                .map(|s| shell_quote(&s))
                .collect::<Vec<_>>()
                .join(" ");
            format!(
                "echo '@@runnerx progress {{\"value\":0.55,\"message\":\"running install\"}}'\n\
                 docker exec -w {work} {cname} sh -c {q}\n",
                work = WORK_DIR,
                cname = cname,
                q = shell_quote(&cmd_line),
            )
        }
        None => String::new(),
    };

    let script_dir_str = script_dir.display().to_string();
    let wrapper = format!(
        "set -e\n\
         trap 'docker rm -f {cname} >/dev/null 2>&1 || true' EXIT\n\
         echo '@@runnerx progress {{\"value\":0.05,\"message\":\"pulling image {base_msg}\"}}'\n\
         docker pull {base_q} 1>&2\n\
         echo '@@runnerx progress {{\"value\":0.35,\"message\":\"starting container\"}}'\n\
         docker run -d --name {cname} \
            --network=bridge \
            -v {script_q}:{src}:ro \
            {base_q} sh -c 'tail -f /dev/null' >/dev/null\n\
         echo '@@runnerx progress {{\"value\":0.45,\"message\":\"copying script files\"}}'\n\
         docker exec {cname} sh -c 'mkdir -p {work} && cp -R {src}/. {work}/'\n\
         {install_step}\
         echo '@@runnerx progress {{\"value\":0.92,\"message\":\"committing image\"}}'\n\
         docker commit {cname} {installed_q} 1>&2\n\
         echo '@@runnerx progress {{\"value\":1.0,\"message\":\"installed\"}}'\n",
        cname = cname,
        base_msg = base_image.replace('\'', ""),
        base_q = shell_quote(&base_image),
        script_q = shell_quote(&script_dir_str),
        src = SCRIPT_SRC_DIR,
        work = WORK_DIR,
        install_step = install_step,
        installed_q = shell_quote(&installed_ref),
    );

    let mut command = Command::new("sh");
    command.arg("-c").arg(wrapper);
    command.kill_on_drop(true);

    let dir_clone = script_dir.clone();
    let installed_for_state = installed_ref.clone();
    let base_for_state = base_image.clone();
    let on_exit: BoxedExitHook = Box::new(move |code, cancelled| {
        if !cancelled && code == Some(0) {
            let s = InstallState {
                version: 1,
                kind: InstallKind::Sandbox,
                image: Some(installed_for_state),
                base_image: Some(base_for_state),
                installed_at: Some(scanner::current_iso_timestamp()),
            };
            let _ = scanner::write_install_state(&dir_clone, &s);
        }
    });

    spawn_event_stream(
        app, state, &mut command, &script_dir, None,
        RunMode::Install, Some(on_exit), Some(run_id), None,
    )
    .await
}

// =====================================================================
// Uninstall
// =====================================================================

pub async fn spawn_sandbox_uninstall(
    app: AppHandle,
    state: Arc<RunnerState>,
    manifest: Manifest,
    script_dir: PathBuf,
    also_remove_base: bool,
) -> Result<String> {
    let install_state = scanner::read_install_state(&script_dir)
        .ok_or_else(|| RxError::Other("script is not installed".into()))?;
    if install_state.kind != InstallKind::Sandbox {
        return Err(RxError::Other("install state is not sandbox; use host uninstall".into()));
    }
    let installed_ref = install_state
        .image
        .clone()
        .ok_or_else(|| RxError::Other("install state missing image ref".into()))?;
    let base_image = install_state.base_image.clone();

    let run_id = Uuid::new_v4().to_string();
    let cname = container_name(&run_id);

    // Run user's uninstall lifecycle (if any) inside a one-shot container based
    // on the installed image, so they can clean up state living in the image fs.
    let lifecycle = manifest.effective_lifecycle();
    let user_uninstall_step = match lifecycle.uninstall {
        Some(c) => {
            let cmd_line = std::iter::once(c.command.clone())
                .chain(c.args.into_iter())
                .map(|s| shell_quote(&s))
                .collect::<Vec<_>>()
                .join(" ");
            format!(
                "echo '@@runnerx progress {{\"value\":0.20,\"message\":\"running uninstall script\"}}'\n\
                 docker run --rm --name {cname} -w {work} --network=none {installed_q} sh -c {q}\n",
                cname = cname,
                work = WORK_DIR,
                installed_q = shell_quote(&installed_ref),
                q = shell_quote(&cmd_line),
            )
        }
        None => String::new(),
    };

    let remove_base_step = if also_remove_base {
        if let Some(b) = &base_image {
            format!(
                "echo '@@runnerx progress {{\"value\":0.85,\"message\":\"removing base image\"}}'\n\
                 docker rmi {b_q} 1>&2 || true\n",
                b_q = shell_quote(b),
            )
        } else { String::new() }
    } else { String::new() };

    let wrapper = format!(
        "set -e\n\
         {user_uninstall_step}\
         echo '@@runnerx progress {{\"value\":0.60,\"message\":\"removing installed image\"}}'\n\
         docker rmi {installed_q} 1>&2 || true\n\
         {remove_base_step}\
         echo '@@runnerx progress {{\"value\":1.0,\"message\":\"uninstalled\"}}'\n",
        user_uninstall_step = user_uninstall_step,
        installed_q = shell_quote(&installed_ref),
        remove_base_step = remove_base_step,
    );

    let mut command = Command::new("sh");
    command.arg("-c").arg(wrapper);
    command.kill_on_drop(true);

    let dir_clone = script_dir.clone();
    let on_exit: BoxedExitHook = Box::new(move |code, cancelled| {
        if !cancelled && code == Some(0) {
            let _ = scanner::clear_install_state(&dir_clone);
        }
    });

    spawn_event_stream(
        app, state, &mut command, &script_dir, None,
        RunMode::Uninstall, Some(on_exit), Some(run_id), None,
    )
    .await
}

// =====================================================================
// Run
// =====================================================================

pub async fn spawn_sandbox_run(
    app: AppHandle,
    state: Arc<RunnerState>,
    manifest: Manifest,
    script_dir: PathBuf,
    inputs: HashMap<String, Value>,
    outputs: HashMap<String, Value>,
) -> Result<String> {
    let install_state = scanner::read_install_state(&script_dir)
        .ok_or_else(|| RxError::Other("script not installed".into()))?;
    if install_state.kind != InstallKind::Sandbox {
        return Err(RxError::Other(
            "script was installed in host mode; reinstall under sandbox before running".into(),
        ));
    }
    let installed_ref = install_state
        .image
        .clone()
        .ok_or_else(|| RxError::Other("install state missing image ref".into()))?;

    let entry = manifest.effective_entry();
    let input_specs = manifest.inputs.clone();

    // 1) Translate inputs: collect mounts + container-side values.
    let mut mounts: Vec<(String, String)> = Vec::new(); // (host, container) pairs (always :ro)
    let mut translated_inputs: HashMap<String, Value> = HashMap::new();
    // container_path → host_path. Sent into spawn_event_stream so any `result`
    // payload referencing a container path is rewritten to host before the
    // frontend gets it (otherwise reveal-in-finder would point at /runnerx/out/...
    // which doesn't exist on host).
    let mut path_map: HashMap<String, String> = HashMap::new();

    for (id, value) in &inputs {
        let spec_ty = input_specs.iter().find(|s| &s.id == id).map(|s| s.ty);
        match spec_ty {
            Some(InputType::File) => {
                let host_path = value.as_str().unwrap_or("").to_string();
                if host_path.is_empty() {
                    translated_inputs.insert(id.clone(), value.clone());
                    continue;
                }
                let filename = Path::new(&host_path).file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("file")
                    .to_string();
                let cpath = format!("{INPUT_DIR}/{id}/{filename}");
                mounts.push((host_path.clone(), cpath.clone()));
                path_map.insert(cpath.clone(), host_path);
                translated_inputs.insert(id.clone(), Value::String(cpath));
            }
            Some(InputType::Files) => {
                if let Some(arr) = value.as_array() {
                    let mut paths: Vec<Value> = Vec::new();
                    for (i, p) in arr.iter().enumerate() {
                        let host_path = p.as_str().unwrap_or("").to_string();
                        if host_path.is_empty() { continue; }
                        let filename = Path::new(&host_path).file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or("file")
                            .to_string();
                        let cpath = format!("{INPUT_DIR}/{id}/{i}/{filename}");
                        mounts.push((host_path.clone(), cpath.clone()));
                        path_map.insert(cpath.clone(), host_path);
                        paths.push(Value::String(cpath));
                    }
                    translated_inputs.insert(id.clone(), Value::Array(paths));
                } else {
                    translated_inputs.insert(id.clone(), value.clone());
                }
            }
            Some(InputType::Directory) => {
                let host_path = value.as_str().unwrap_or("").to_string();
                if host_path.is_empty() {
                    translated_inputs.insert(id.clone(), value.clone());
                    continue;
                }
                let cpath = format!("{INPUT_DIR}/{id}");
                mounts.push((host_path.clone(), cpath.clone()));
                path_map.insert(cpath.clone(), host_path);
                translated_inputs.insert(id.clone(), Value::String(cpath));
            }
            _ => {
                translated_inputs.insert(id.clone(), value.clone());
            }
        }
    }

    // 2) Outputs: stage to a host tmpdir, mount as rw, swap into user's chosen
    //    location after the run exits 0.
    let tmp_root = std::env::temp_dir().join(format!("runnerx-out-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&tmp_root)?;
    let mut translated_outputs: HashMap<String, Value> = HashMap::new();
    let mut output_swap: Vec<(PathBuf, PathBuf)> = Vec::new();
    let mut rw_mounts: Vec<(String, String)> = Vec::new();

    for (id, value) in &outputs {
        let host_user_path = value.as_str().unwrap_or("").to_string();
        if host_user_path.is_empty() {
            translated_outputs.insert(id.clone(), value.clone());
            continue;
        }
        let filename = Path::new(&host_user_path).file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("output")
            .to_string();
        let host_tmp_dir = tmp_root.join(id);
        std::fs::create_dir_all(&host_tmp_dir)?;
        let host_tmp_file = host_tmp_dir.join(&filename);
        let container_dir = format!("{OUTPUT_DIR}/{id}");
        let container_file = format!("{container_dir}/{filename}");
        rw_mounts.push((host_tmp_dir.display().to_string(), container_dir));
        // Map both the file path and the dir prefix; the dir prefix lets
        // longest-prefix-match still translate something if the script reports
        // a slightly different filename inside the staging dir.
        path_map.insert(container_file.clone(), host_user_path.clone());
        translated_outputs.insert(id.clone(), Value::String(container_file));
        output_swap.push((host_tmp_file, PathBuf::from(host_user_path)));
    }

    // 3) Build entry shell command using translated values + env from inputs.
    let env_pairs = build_env_pairs(&translated_inputs, &translated_outputs, &input_specs, entry.args_mode);
    let argv_extra = if matches!(entry.args_mode, ArgsMode::Argv) {
        build_argv_extra(&translated_inputs, &translated_outputs, &input_specs)
    } else {
        Vec::new()
    };

    let entry_cmd_line = std::iter::once(entry.command.clone())
        .chain(entry.args.iter().cloned())
        .chain(argv_extra.into_iter())
        .map(|s| shell_quote(&s))
        .collect::<Vec<_>>()
        .join(" ");

    // 4) docker run.
    let run_id = Uuid::new_v4().to_string();
    let cname = container_name(&run_id);

    let cfg = crate::config::load();
    let network = cfg.sandbox.network.as_docker_arg();

    let mut command = Command::new("docker");
    command.arg("run").arg("--rm").arg("-i");
    command.arg("--name").arg(&cname);
    command.arg(format!("--network={network}"));
    command.arg("-w").arg(WORK_DIR);
    for (host, cont) in &mounts {
        command.arg("-v").arg(format!("{host}:{cont}:ro"));
    }
    for (host, cont) in &rw_mounts {
        command.arg("-v").arg(format!("{host}:{cont}:rw"));
    }
    for (k, v) in &env_pairs {
        command.arg("-e").arg(format!("{k}={v}"));
    }
    command.arg(&installed_ref);
    command.arg("sh").arg("-c").arg(&entry_cmd_line);
    command.kill_on_drop(true);

    let stdin_payload = if matches!(entry.args_mode, ArgsMode::StdinJson) {
        Some(json!({ "inputs": translated_inputs, "outputs": translated_outputs }).to_string())
    } else {
        None
    };

    let tmp_root_for_exit = tmp_root.clone();
    let on_exit: BoxedExitHook = Box::new(move |code, cancelled| {
        if !cancelled && code == Some(0) {
            for (tmp_path, user_path) in &output_swap {
                if tmp_path.exists() {
                    if let Some(parent) = user_path.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    // Try rename first (same fs); fall back to copy + remove.
                    if std::fs::rename(tmp_path, user_path).is_err() {
                        if let Ok(bytes) = std::fs::read(tmp_path) {
                            let _ = std::fs::write(user_path, bytes);
                            let _ = std::fs::remove_file(tmp_path);
                        }
                    }
                }
            }
        }
        let _ = std::fs::remove_dir_all(&tmp_root_for_exit);
    });

    spawn_event_stream(
        app, state, &mut command, &script_dir, stdin_payload,
        RunMode::Script, Some(on_exit), Some(run_id), Some(path_map),
    )
    .await
}

// =====================================================================
// Helpers shared with host mode (kept here because they consume already-
// translated container paths; differs from the host versions only in path
// scheme).
// =====================================================================

fn build_env_pairs(
    inputs: &HashMap<String, Value>,
    outputs: &HashMap<String, Value>,
    input_specs: &[crate::manifest::InputSpec],
    args_mode: ArgsMode,
) -> Vec<(String, String)> {
    if !matches!(args_mode, ArgsMode::Env) {
        return Vec::new();
    }
    let mut out = Vec::new();
    for (key, value) in inputs {
        let spec = input_specs.iter().find(|s| &s.id == key);
        out.push((format!("RUNNERX_{}", key.to_uppercase()), value_to_string(value, spec)));
    }
    for (key, value) in outputs {
        out.push((format!("RUNNERX_OUT_{}", key.to_uppercase()), value_to_string(value, None)));
    }
    out
}

fn build_argv_extra(
    inputs: &HashMap<String, Value>,
    outputs: &HashMap<String, Value>,
    input_specs: &[crate::manifest::InputSpec],
) -> Vec<String> {
    let mut out = Vec::new();
    for (key, value) in inputs {
        let spec = input_specs.iter().find(|s| &s.id == key);
        let kebab = key.replace('_', "-").to_lowercase();
        let flag = format!("--{kebab}");
        if let Some(s) = spec {
            if s.ty == InputType::Boolean {
                if value.as_bool().unwrap_or(false) { out.push(flag); }
                continue;
            }
            if s.ty == InputType::Files {
                if let Some(arr) = value.as_array() {
                    for item in arr {
                        let v = scalar_to_string(item);
                        if !v.is_empty() { out.push(format!("{flag}={v}")); }
                    }
                    continue;
                }
            }
        }
        let v = value_to_string(value, spec);
        if !v.is_empty() { out.push(format!("{flag}={v}")); }
    }
    for (key, value) in outputs {
        let kebab = key.replace('_', "-").to_lowercase();
        let v = value_to_string(value, None);
        if !v.is_empty() { out.push(format!("--out-{kebab}={v}")); }
    }
    out
}

fn value_to_string(value: &Value, spec: Option<&crate::manifest::InputSpec>) -> String {
    if let Some(s) = spec {
        match s.ty {
            InputType::Boolean => return value.as_bool().map(|b| if b { "1" } else { "0" }).unwrap_or("0").into(),
            InputType::Files => {
                if let Some(arr) = value.as_array() {
                    // Inside the container we use ':' as separator regardless of host OS.
                    return arr.iter().map(scalar_to_string).collect::<Vec<_>>().join(":");
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
