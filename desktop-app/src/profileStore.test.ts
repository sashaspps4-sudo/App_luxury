import assert from "node:assert/strict";
import test from "node:test";
import { loadProfiles, deleteProfile } from "./profileStore.ts";

test("legacy profiles receive stable UUIDs without changing browser directories or proxies", async () => {
  Object.assign(globalThis, { window: {}, localStorage: {
    value: JSON.stringify({ profiles: [{ id: "3", proxy: "socks5://proxy.test:1080" }], nextId: 4 }),
    getItem() { return this.value; },
    setItem(_key: string, value: string) { this.value = value; },
  } });
  const first = await loadProfiles();
  assert.match(first.profiles[0].id, /^[a-f0-9-]{36}$/);
  assert.equal(first.profiles[0].directoryId, "3");
  assert.equal(first.profiles[0].legacyId, "3");
  assert.equal(first.profiles[0].proxy, "socks5://proxy.test:1080");
  assert.deepEqual(await loadProfiles(), first);
  const id = first.profiles[0].id;
  await deleteProfile(id, { ...first, profiles: [], deletedIds: [id] });
  const reloaded = await loadProfiles();
  assert.deepEqual(reloaded.profiles, []);
  assert.deepEqual(reloaded.deletedIds, [id]);
});
