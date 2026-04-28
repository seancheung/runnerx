import { Store } from "@tauri-apps/plugin-store";

let storePromise: Promise<Store> | null = null;

function getStore(): Promise<Store> {
  if (!storePromise) {
    storePromise = Store.load("settings.json");
  }
  return storePromise;
}

export async function getScriptsRoot(): Promise<string | null> {
  const store = await getStore();
  return ((await store.get<string>("scriptsRoot")) ?? null);
}

export async function setScriptsRoot(path: string): Promise<void> {
  const store = await getStore();
  await store.set("scriptsRoot", path);
  await store.save();
}

export async function clearScriptsRoot(): Promise<void> {
  const store = await getStore();
  await store.delete("scriptsRoot");
  await store.save();
}

export type ThemePreference = "system" | "dark" | "light";

export async function getTheme(): Promise<ThemePreference> {
  const store = await getStore();
  const v = await store.get<string>("theme");
  return v === "dark" || v === "light" ? v : "system";
}

export async function setTheme(theme: ThemePreference): Promise<void> {
  const store = await getStore();
  if (theme === "system") {
    await store.delete("theme");
  } else {
    await store.set("theme", theme);
  }
  await store.save();
}

export function applyTheme(theme: ThemePreference): void {
  const root = document.documentElement;
  if (theme === "system") {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = theme;
  }
}
