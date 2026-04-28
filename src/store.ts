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
