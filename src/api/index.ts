import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { RunEvent, ScanResult, ScriptInfo } from "../types/manifest";
import type { AppConfig } from "../types/config";

export const RUN_EVENT = "run-event";

export async function listScripts(root: string): Promise<ScanResult> {
  return await invoke<ScanResult>("list_scripts", { root });
}

export async function defaultScriptsRoot(): Promise<string> {
  return await invoke<string>("default_scripts_root");
}

export async function getConfig(): Promise<AppConfig> {
  return await invoke<AppConfig>("get_config");
}

export async function setConfig(config: AppConfig): Promise<void> {
  await invoke("set_config", { config });
}

export async function readScript(dir: string): Promise<ScriptInfo> {
  return await invoke<ScriptInfo>("read_script", { dir });
}

export interface ScriptFileEntry {
  path: string;
  content: string;
  executable: boolean;
}

export async function readScriptFiles(dir: string): Promise<ScriptFileEntry[]> {
  return await invoke<ScriptFileEntry[]>("read_script_files", { dir });
}

export async function readReadme(path: string): Promise<string> {
  return await invoke<string>("read_readme", { path });
}

export async function runScript(
  scriptDir: string,
  inputs: Record<string, unknown>,
  outputs: Record<string, unknown> = {},
): Promise<string> {
  return await invoke<string>("run_script", {
    request: { scriptDir, inputs, outputs },
  });
}

export async function runInstall(dir: string): Promise<string> {
  return await invoke<string>("run_install", { dir });
}

export async function runUninstall(dir: string, alsoRemoveBase = false): Promise<string> {
  // 拆成两个命令而不是用一个布尔参数 — Tauri 2 IPC 在多 user 参数 + Option<bool>
  // 组合下偶发 "expected boolean, got map" 解析错误，单参数 String 风格最稳。
  return alsoRemoveBase
    ? await invoke<string>("run_uninstall_with_base", { dir })
    : await invoke<string>("run_uninstall", { dir });
}

export async function cancelRun(runId: string): Promise<void> {
  await invoke("cancel_run", { runId });
}

export async function currentRun(): Promise<string | null> {
  return await invoke<string | null>("current_run");
}

export async function onRunEvent(handler: (e: RunEvent) => void): Promise<UnlistenFn> {
  return await listen<RunEvent>(RUN_EVENT, (msg) => handler(msg.payload));
}

export interface WriteFileSpec {
  path: string;
  content: string;
  executable?: boolean;
}

export async function writeScriptFiles(
  root: string,
  scriptId: string,
  files: WriteFileSpec[],
  overwrite = false,
): Promise<string> {
  return await invoke<string>("write_script_files", {
    request: { root, scriptId, files, overwrite },
  });
}
