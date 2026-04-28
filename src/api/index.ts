import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { RunEvent, ScanResult, ScriptInfo } from "../types/manifest";

export const RUN_EVENT = "run-event";

export async function listScripts(root: string): Promise<ScanResult> {
  return await invoke<ScanResult>("list_scripts", { root });
}

export async function defaultScriptsRoot(): Promise<string> {
  return await invoke<string>("default_scripts_root");
}

export async function readScript(dir: string): Promise<ScriptInfo> {
  return await invoke<ScriptInfo>("read_script", { dir });
}

export async function readReadme(path: string): Promise<string> {
  return await invoke<string>("read_readme", { path });
}

export async function markUninstalled(dir: string): Promise<void> {
  await invoke("mark_uninstalled", { dir });
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

export async function runUninstall(dir: string): Promise<string> {
  return await invoke<string>("run_uninstall", { dir });
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
