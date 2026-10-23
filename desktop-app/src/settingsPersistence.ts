import { invoke, isTauri } from "@tauri-apps/api/core";
import { createDefaultSettingsStore, normalizeSettingsStore, type SettingsStore } from "./settingsModel";

const storageKey = "luxury-mailer.settings.v1";

export async function loadSettingsStore(): Promise<SettingsStore> {
  if (isTauri()) {
    const contents = await invoke<string | null>("load_settings");
    return contents ? normalizeSettingsStore(JSON.parse(contents) as unknown) : createDefaultSettingsStore();
  }

  const contents = window.localStorage.getItem(storageKey);
  return contents ? normalizeSettingsStore(JSON.parse(contents) as unknown) : createDefaultSettingsStore();
}

export async function saveSettingsStore(store: SettingsStore): Promise<void> {
  const contents = JSON.stringify(store, null, 2);
  if (isTauri()) {
    await invoke("save_settings", { contents });
    window.dispatchEvent(new Event("luxury-settings-saved"));
    return;
  }

  window.localStorage.setItem(storageKey, contents);
  window.dispatchEvent(new Event("luxury-settings-saved"));
}
