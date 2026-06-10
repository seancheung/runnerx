import * as api from "./api";
import type { ThemePreference } from "./types/config";

export type { ThemePreference };

export async function getScriptsRoot(): Promise<string | null> {
  const cfg = await api.getConfig();
  return cfg.scriptsRoot ?? null;
}

export async function setScriptsRoot(path: string): Promise<void> {
  const cfg = await api.getConfig();
  cfg.scriptsRoot = path;
  await api.setConfig(cfg);
}

export async function clearScriptsRoot(): Promise<void> {
  const cfg = await api.getConfig();
  cfg.scriptsRoot = null;
  await api.setConfig(cfg);
}

export async function getTheme(): Promise<ThemePreference> {
  const cfg = await api.getConfig();
  const v = cfg.theme;
  return v === "dark" || v === "light" ? v : "system";
}

export async function setTheme(theme: ThemePreference): Promise<void> {
  const cfg = await api.getConfig();
  cfg.theme = theme === "system" ? null : theme;
  await api.setConfig(cfg);
}

export function applyTheme(theme: ThemePreference): void {
  const root = document.documentElement;
  if (theme === "system") {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = theme;
  }
}
