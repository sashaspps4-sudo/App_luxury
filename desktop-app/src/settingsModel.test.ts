import assert from "node:assert/strict";
import test from "node:test";
import {
  createDefaultSettingsConfig,
  createDefaultSettingsStore,
  createPreset,
  deletePreset,
  normalizeSettingsStore,
  renamePreset,
} from "./settingsModel.ts";

test("presets keep text templates isolated through create, edit, rename, delete, and reload", () => {
  const initial = createDefaultSettingsStore();
  initial.configs.Default.templates.Depop = "default text";
  initial.configs.Default.apiKey = "default-key";

  let configs = createPreset(initial.configs, "Second");
  assert.equal(configs.Default.templates.Depop, "default text");
  assert.equal(configs.Second.templates.Depop, "");
  assert.equal(configs.Second.apiKey, "");

  configs.Second.templates.Depop = "second preset text";
  assert.equal(configs.Default.templates.Depop, "default text");

  configs = renamePreset(configs, "Second", "Renamed");
  assert.equal(configs.Renamed.templates.Depop, "second preset text");
  assert.equal(configs.Default.templates.Depop, "default text");

  const reloaded = normalizeSettingsStore(JSON.parse(JSON.stringify({
    version: 1,
    selectedConfig: "Renamed",
    configs,
  })) as unknown);
  assert.equal(reloaded.selectedConfig, "Renamed");
  assert.equal(reloaded.configs.Renamed.templates.Depop, "second preset text");
  assert.equal(reloaded.configs.Default.templates.Depop, "default text");

  configs = deletePreset(reloaded.configs, "Renamed");
  assert.equal(configs.Renamed, undefined);
  assert.equal(configs.Default.templates.Depop, "default text");
});

test("preset names are validated and Default is protected", () => {
  const configs = { Default: createDefaultSettingsConfig() };
  assert.throws(() => createPreset(configs, "  "), /название/i);
  assert.throws(() => createPreset(configs, "Default"), /уже существует/i);
  assert.throws(() => renamePreset(configs, "Default", "New name"), /Default нельзя/i);
  assert.throws(() => deletePreset(configs, "Default"), /Default нельзя/i);
});
