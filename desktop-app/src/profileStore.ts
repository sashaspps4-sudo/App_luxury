import { invoke, isTauri } from "@tauri-apps/api/core";

export type BrowserProfile = { id: string; proxy: string; directoryId?: string; legacyId?: string };
export type ProfileStore = { profiles: BrowserProfile[]; nextId: number; deletedIds?: string[] };
const key = "luxury-mailer.profiles.v1";
export const defaultProfiles = (): ProfileStore => ({ profiles: [1, 2, 3].map(id => ({ id: String(id), proxy: "" })), nextId: 4 });
export async function loadProfiles(): Promise<ProfileStore> {
  const contents = isTauri() ? await invoke<string | null>("load_profiles") : localStorage.getItem(key);
  const value = contents ? JSON.parse(contents) as ProfileStore : defaultProfiles();
  if (!Array.isArray(value.profiles) || value.profiles.length > 20 || !Number.isSafeInteger(value.nextId) || value.nextId < 1
    || value.profiles.some(p => !/^(?:[1-9]\d{0,8}|[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/.test(p.id) || typeof p.proxy !== "string" || p.proxy.length > 2048 || (/^[1-9]\d{0,8}$/.test(p.id) && Number(p.id) >= value.nextId)
      || (p.directoryId !== undefined && !/^[1-9]\d{0,8}$/.test(p.directoryId))
      || (p.legacyId !== undefined && p.legacyId !== p.directoryId))
    || new Set(value.profiles.map(p => p.id)).size !== value.profiles.length) throw new Error("Не удалось прочитать сохранённые профили.");
  if (value.deletedIds && (!Array.isArray(value.deletedIds) || value.deletedIds.length > 10000 || value.deletedIds.some(id => !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)))) throw new Error("Некорректный список удалённых профилей.");
  let migrated = !contents;
  value.profiles = value.profiles.map(profile => {
    if (profile.id.includes("-")) return profile;
    migrated = true;
    return { ...profile, id: crypto.randomUUID(), directoryId: profile.id, legacyId: profile.id };
  });
  if (migrated) await saveProfiles(value);
  return value;
}
let saveQueue = Promise.resolve();
export function saveProfiles(value: ProfileStore): Promise<void> {
  const contents = JSON.stringify(value);
  const save = saveQueue.catch(() => {}).then(async () => {
    if (isTauri()) await invoke("save_profiles", { contents });
    else localStorage.setItem(key, contents);
  });
  saveQueue = save;
  return save;
}

export function deleteProfile(id: string, value: ProfileStore): Promise<void> {
  const contents = JSON.stringify(value);
  const deletion = saveQueue.catch(() => {}).then(async () => {
    if (isTauri()) await invoke("delete_profile", { id, contents });
    else localStorage.setItem(key, contents);
  });
  saveQueue = deletion;
  return deletion;
}
