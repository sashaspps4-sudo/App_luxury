import { marketplacePlatforms } from "./marketplaceData";

export interface ParserFilters {
  viewsMax: string;
  reviewsMin: string;
  reviewsMax: string;
  sellsMin: string;
  sellsMax: string;
  publicationValue: string;
  publicationUnit: string;
  adsMin: string;
  adsMax: string;
  priceMin: string;
  priceMax: string;
}

export interface SettingsConfig {
  provider: string;
  databaseSource: "parser" | "custom";
  platform: string;
  apiKey: string;
  parserApi: string;
  customEmails: string;
  parserFilters: ParserFilters;
  userId: string;
  endpoint: string;
  requestBody: string;
  responsePath: string;
  buyerName: string;
  buyerAddress: string;
  serviceCode: string;
  selectedGeos: string[];
  mode: string;
  workflowMode: "broadcast" | "funnel";
  subjectLines: string;
  previewPlatform: string;
  previewGeo: string;
  customHtml: string;
  templates: Record<string, string>;
}

export interface SettingsStore {
  version: 1;
  selectedConfig: string;
  configs: Record<string, SettingsConfig>;
}

const templatePlatforms = ["Default (Общие)", ...marketplacePlatforms];

export function createDefaultSettingsConfig(): SettingsConfig {
  return {
    provider: "kartatai",
    databaseSource: "parser",
    platform: templatePlatforms[0],
    apiKey: "",
    parserApi: "",
    customEmails: "",
    parserFilters: {
      viewsMax: "", reviewsMin: "", reviewsMax: "", sellsMin: "", sellsMax: "",
      publicationValue: "", publicationUnit: "hours", adsMin: "", adsMax: "", priceMin: "", priceMax: "",
    },
    userId: "",
    endpoint: "",
    requestBody: "",
    responsePath: "",
    buyerName: "",
    buyerAddress: "",
    serviceCode: "Depop",
    selectedGeos: ["AU"],
    mode: "verif",
    workflowMode: "funnel",
    subjectLines: "",
    previewPlatform: "Depop",
    previewGeo: "AU",
    customHtml: '<div style="padding: 32px; font-family: Arial, sans-serif; color: #171717;">\n  <h1>Your custom template</h1>\n  <p>Start editing the HTML to see the result.</p>\n</div>',
    templates: Object.fromEntries(templatePlatforms.map((item) => [item, ""])),
  };
}

export function createDefaultSettingsStore(): SettingsStore {
  return { version: 1, selectedConfig: "Default", configs: { Default: createDefaultSettingsConfig() } };
}

export function normalizeSettingsStore(value: unknown): SettingsStore {
  if (!value || typeof value !== "object") throw new Error("Файл конфигурации имеет неверный формат.");
  const parsed = value as Partial<SettingsStore>;
  if (!parsed.configs || typeof parsed.configs !== "object") throw new Error("В файле не найдены пресеты.");

  const defaults = createDefaultSettingsConfig();
  const configs = Object.fromEntries(Object.entries(parsed.configs).map(([name, config]) => {
    const partial = config as Partial<SettingsConfig>;
    return [name, {
      ...defaults,
      ...partial,
      parserFilters: { ...defaults.parserFilters, ...partial.parserFilters },
      templates: { ...defaults.templates, ...partial.templates },
      selectedGeos: [...(partial.selectedGeos ?? defaults.selectedGeos)],
    } satisfies SettingsConfig];
  }));
  if (!configs.Default) configs.Default = createDefaultSettingsConfig();
  const selectedConfig = parsed.selectedConfig && configs[parsed.selectedConfig] ? parsed.selectedConfig : "Default";
  return { version: 1, selectedConfig, configs };
}

export function createPreset(configs: Record<string, SettingsConfig>, name: string): Record<string, SettingsConfig> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Укажи название пресета.");
  if (configs[trimmed]) throw new Error("Пресет с таким названием уже существует.");
  return { ...configs, [trimmed]: createDefaultSettingsConfig() };
}

export function renamePreset(configs: Record<string, SettingsConfig>, currentName: string, nextName: string): Record<string, SettingsConfig> {
  const trimmed = nextName.trim();
  if (currentName === "Default") throw new Error("Пресет Default нельзя переименовать.");
  if (!configs[currentName]) throw new Error("Пресет не найден.");
  if (!trimmed) throw new Error("Укажи название пресета.");
  if (trimmed !== currentName && configs[trimmed]) throw new Error("Пресет с таким названием уже существует.");
  if (trimmed === currentName) return configs;

  const source = configs[currentName];
  const next = { ...configs };
  delete next[currentName];
  next[trimmed] = {
    ...source,
    parserFilters: { ...source.parserFilters },
    selectedGeos: [...source.selectedGeos],
    templates: { ...source.templates },
  };
  return next;
}

export function deletePreset(configs: Record<string, SettingsConfig>, name: string): Record<string, SettingsConfig> {
  if (name === "Default") throw new Error("Пресет Default нельзя удалить.");
  if (!configs[name]) throw new Error("Пресет не найден.");
  const next = { ...configs };
  delete next[name];
  return next;
}
