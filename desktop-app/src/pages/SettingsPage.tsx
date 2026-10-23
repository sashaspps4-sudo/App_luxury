import { useEffect, useMemo, useRef, useState } from "react";
import { AtSign, Braces, Check, CircleAlert, CircleCheck, CircleHelp, Code2, Eye, KeyRound, Layers3, Link2, MapPin, Pencil, Plus, Route, Save, Trash2, UserRound, X } from "lucide-react";
import { GlassButton, Panel } from "../components/ui";
import { CustomSelect } from "../components/CustomSelect";
import { createDefaultSettingsConfig, createPreset, deletePreset, renamePreset, type SettingsConfig } from "../settingsModel";
import { loadSettingsStore, saveSettingsStore } from "../settingsPersistence";
import { marketplaceGeos, marketplacePlatforms } from "../marketplaceData";
import { eqlCategories, eqlGeoAllowed } from "../eqlCategories";

const providers = [
  { id: "kartatai", name: "KARTATAI" },
  { id: "eql", name: "EQL TEAM" },
  { id: "custom", name: "Кастомный" },
];

const platforms = ["Default (Общие)", ...marketplacePlatforms];
const serviceCodes = marketplacePlatforms;
const previewPlatforms = [...marketplacePlatforms, "Custom"];
const geoOptions = marketplaceGeos;
const htmlTemplates = import.meta.glob("../templates/html/*/*/template.html", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

export function SettingsPage() {
  const [configs, setConfigs] = useState(["Default"]);
  const [selectedConfig, setSelectedConfig] = useState("Default");
  const [subjectLines, setSubjectLines] = useState("");
  const settingsByConfig = useRef<Record<string, SettingsConfig>>({ Default: createDefaultSettingsConfig() });
  const [storageReady, setStorageReady] = useState(false);
  const [storageError, setStorageError] = useState("");
  const [saving, setSaving] = useState(false);
  const [configEditor, setConfigEditor] = useState<"add" | "rename" | null>(null);
  const [configNameDraft, setConfigNameDraft] = useState("");
  const [provider, setProvider] = useState("kartatai");
  const [databaseSource, setDatabaseSource] = useState<"parser" | "custom">("parser");
  const [apiKey, setApiKey] = useState("");
  const [parserApi, setParserApi] = useState("");
  const [customEmails, setCustomEmails] = useState("");
  const [parserFilters, setParserFilters] = useState({
    viewsMax: "",
    reviewsMin: "",
    reviewsMax: "",
    sellsMin: "",
    sellsMax: "",
    publicationValue: "",
    publicationUnit: "hours",
    adsMin: "",
    adsMax: "",
    priceMin: "",
    priceMax: "",
  });
  const [userId, setUserId] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [requestBody, setRequestBody] = useState("");
  const [responsePath, setResponsePath] = useState("");
  const [buyerName, setBuyerName] = useState("");
  const [buyerAddress, setBuyerAddress] = useState("");
  const [customCheckStatus, setCustomCheckStatus] = useState<"idle" | "valid" | "invalid">("idle");
  const [serviceCode, setServiceCode] = useState("Depop");
  const [selectedGeos, setSelectedGeos] = useState<string[]>(["AU"]);
  const [mode, setMode] = useState("verif");
  const [workflowMode, setWorkflowMode] = useState<"broadcast" | "funnel">("funnel");
  const [workflowHelpOpen, setWorkflowHelpOpen] = useState(false);
  const [previewPlatform, setPreviewPlatform] = useState("Depop");
  const [previewGeo, setPreviewGeo] = useState("AU");
  const [customHtml, setCustomHtml] = useState('<div style="padding: 32px; font-family: Arial, sans-serif; color: #171717;">\n  <h1>Your custom template</h1>\n  <p>Start editing the HTML to see the result.</p>\n</div>');
  const [templates, setTemplates] = useState<Record<string, string>>(() =>
    Object.fromEntries(platforms.map((item) => [item, ""])),
  );
  const [saved, setSaved] = useState(false);

  function applySettingsConfig(config: SettingsConfig) {
    setProvider(config.provider);
    setDatabaseSource(config.databaseSource);
    setApiKey(config.apiKey);
    setParserApi(config.parserApi);
    setCustomEmails(config.customEmails);
    setParserFilters(config.parserFilters);
    setUserId(config.userId);
    setEndpoint(config.endpoint);
    setRequestBody(config.requestBody);
    setResponsePath(config.responsePath);
    setBuyerName(config.buyerName);
    setBuyerAddress(config.buyerAddress);
    setServiceCode(config.serviceCode);
    setSelectedGeos(config.selectedGeos);
    setMode(config.mode);
    setWorkflowMode(config.workflowMode);
    setSubjectLines(config.subjectLines ?? "");
    setPreviewPlatform(config.previewPlatform);
    setPreviewGeo(config.previewGeo);
    setCustomHtml(config.customHtml);
    setTemplates(config.templates);
    setCustomCheckStatus("idle");
  }

  function getCurrentSettingsConfig(): SettingsConfig {
    return {
      provider, databaseSource, platform: serviceCode, apiKey, parserApi, customEmails,
      parserFilters: { ...parserFilters }, userId, endpoint, requestBody, responsePath, buyerName, buyerAddress,
      serviceCode, selectedGeos: [...selectedGeos], mode, workflowMode, subjectLines,
      previewPlatform, previewGeo, customHtml, templates: { ...templates },
    };
  }

  function snapshotSettingsByConfig(): Record<string, SettingsConfig> {
    return { ...settingsByConfig.current, [selectedConfig]: getCurrentSettingsConfig() };
  }

  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const store = await loadSettingsStore();
        if (!mounted) return;
        const nextConfigs = { ...store.configs };
        if (!nextConfigs.Default) nextConfigs.Default = createDefaultSettingsConfig();
        const configNames = Object.keys(nextConfigs);
        const activeConfig = nextConfigs[store.selectedConfig] ? store.selectedConfig : "Default";
        settingsByConfig.current = nextConfigs;
        setConfigs(configNames);
        setSelectedConfig(activeConfig);
        applySettingsConfig(nextConfigs[activeConfig]);
      } catch (error) {
        if (mounted) setStorageError(error instanceof Error ? error.message : "Не удалось загрузить локальные настройки.");
      } finally {
        if (mounted) setStorageReady(true);
      }
    })();
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (storageReady) setSaved(false);
  }, [storageReady, provider, databaseSource, apiKey, parserApi, customEmails, parserFilters, userId, endpoint, requestBody, responsePath, buyerName, buyerAddress, serviceCode, selectedGeos, mode, workflowMode, subjectLines, previewPlatform, previewGeo, customHtml, templates]);

  const kartataiModeAllowed = (candidate: string) => provider !== "kartatai" || (
    serviceCode !== "OLX" &&
    !(candidate === "verif" && (serviceCode === "2dehands" || (serviceCode === "Wallapop" && selectedGeos.includes("IT")))) &&
    !(candidate === "2.0" && ["Kijiji"].includes(serviceCode))
  );
  useEffect(() => {
    if (provider !== "kartatai") return;
    if (serviceCode === "OLX") {
      setServiceCode("Depop");
      setSelectedGeos(["AU"]);
      setMode("verif");
    } else if (!kartataiModeAllowed(mode)) {
      setMode(mode === "verif" ? "2.0" : "verif");
    }
  }, [provider, serviceCode, mode, selectedGeos]);

  const templateCount = useMemo(
    () => templates[serviceCode].split("\n").filter((line) => line.trim().length > 0).length,
    [serviceCode, templates],
  );
  const emailCount = useMemo(
    () => customEmails.split("\n").filter((line) => line.trim().length > 0).length,
    [customEmails],
  );
  const availablePreviewPlatforms = databaseSource === "custom" ? ["Custom"] : previewPlatforms;
  const availablePreviewGeos = previewPlatform === "Custom" ? [] : geoOptions[previewPlatform];
  const availableServiceGeos = geoOptions[serviceCode];

  function updateTemplates(value: string) {
    setSaved(false);
    setTemplates((current) => ({ ...current, [serviceCode]: value }));
  }

  async function saveTemplates() {
    if (!storageReady || saving) return;
    const nextConfigs = snapshotSettingsByConfig();
    setSaving(true);
    setSaved(false);
    setStorageError("");
    try {
      await saveSettingsStore({ version: 1, selectedConfig, configs: nextConfigs });
      settingsByConfig.current = nextConfigs;
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2400);
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : "Не удалось сохранить локальные настройки.");
    } finally {
      setSaving(false);
    }
  }

  function checkCustomProvider() {
    try {
      const parsedEndpoint = new URL(endpoint);
      if (!/^https?:$/.test(parsedEndpoint.protocol) || !requestBody.trim()) throw new Error("Invalid configuration");
      JSON.parse(requestBody);
      setCustomCheckStatus("valid");
    } catch {
      setCustomCheckStatus("invalid");
    }
  }

  function openConfigEditor(mode: "add" | "rename") {
    setConfigEditor(mode);
    setConfigNameDraft(mode === "rename" ? selectedConfig : "");
  }

  function commitConfigName() {
    const name = configNameDraft.trim();
    if (!name) return;

    try {
      if (configEditor === "add") {
        const currentConfigs = snapshotSettingsByConfig();
        const nextConfigs = createPreset(currentConfigs, name);
        settingsByConfig.current = nextConfigs;
        setConfigs(Object.keys(nextConfigs));
        setSelectedConfig(name);
        applySettingsConfig(nextConfigs[name]);
      } else if (configEditor === "rename") {
        const nextConfigs = renamePreset(snapshotSettingsByConfig(), selectedConfig, name);
        settingsByConfig.current = nextConfigs;
        setConfigs(Object.keys(nextConfigs));
        setSelectedConfig(name);
      }
      setStorageError("");
      setSaved(false);
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : "Не удалось изменить пресет.");
      return;
    }

    setConfigEditor(null);
    setConfigNameDraft("");
  }

  function deleteConfig() {
    if (selectedConfig === "Default") return;
    const nextConfigs = deletePreset(settingsByConfig.current, selectedConfig);
    settingsByConfig.current = nextConfigs;
    setConfigs(Object.keys(nextConfigs));
    setSelectedConfig("Default");
    applySettingsConfig(nextConfigs.Default ?? createDefaultSettingsConfig());
    setConfigEditor(null);
    setSaved(false);
  }

  function selectConfig(name: string) {
    const nextConfigs = snapshotSettingsByConfig();
    settingsByConfig.current = nextConfigs;
    setSelectedConfig(name);
    applySettingsConfig(nextConfigs[name] ?? createDefaultSettingsConfig());
    setConfigEditor(null);
  }

  function selectServiceCode(service: string) {
    setServiceCode(service);
    setSelectedGeos([geoOptions[service][0]]);
    setSaved(false);
  }

  function selectPreviewPlatform(value: string) {
    setPreviewPlatform(value);
    if (value !== "Custom") setPreviewGeo(geoOptions[value][0]);
  }

  function toggleGeo(geo: string) {
    setSelectedGeos((current) => {
      if (!current.includes(geo)) return [...current, geo];
      return current.length > 1 ? current.filter((item) => item !== geo) : current;
    });
  }

  function updateParserFilter(field: keyof typeof parserFilters, value: string) {
    setParserFilters((current) => ({ ...current, [field]: value }));
  }

  if (!storageReady) {
    return (
      <div className="settings-page settings-loading" aria-busy="true" aria-label="Загрузка настроек">
        <section className="page-heading settings-heading">
          <div className="settings-heading-content">
            <p className="kicker">LUXURY / CONFIGURATION</p>
            <div className="settings-title-row"><h1>Настройки</h1><span className="settings-skeleton settings-skeleton-button" /></div>
            <p>Единый центр управления API, шаблонами рассылок, папками ответов и переносом конфигурации.</p>
          </div>
        </section>
        <div className="settings-layout">
          {["main", "side"].map((column) => <div className="settings-loading-card panel-surface" key={column}>
            <span className="settings-skeleton settings-skeleton-short" />
            <span className="settings-skeleton settings-skeleton-title" />
            <span className="settings-skeleton settings-skeleton-line" />
            <span className="settings-skeleton settings-skeleton-control" />
            <span className="settings-skeleton settings-skeleton-line medium" />
            <span className="settings-skeleton settings-skeleton-control" />
            <span className="settings-skeleton settings-skeleton-line short" />
          </div>)}
        </div>
      </div>
    );
  }

  return (
    <div className="settings-page">
      <section className="page-heading settings-heading">
        <div className="settings-heading-content">
          <p className="kicker">LUXURY / CONFIGURATION</p>
          <div className="settings-title-row">
            <h1>Настройки</h1>
            <div className="settings-save-actions">
              {saved && <span className="saved-message"><Check size={13} /> Сохранено</span>}
              {storageError && <span className="saved-message storage-error" role="alert">{storageError}</span>}
              <GlassButton className="settings-save-button" variant="primary" disabled={saving} onClick={saveTemplates}><Save size={15} />{saving ? "СОХРАНЕНИЕ…" : "СОХРАНИТЬ"}</GlassButton>
            </div>
          </div>
          <p>Единый центр управления API, шаблонами рассылок, папками ответов и переносом конфигурации.</p>
        </div>
      </section>

      <div className="settings-layout">
        <Panel className="provider-panel settings-card">
          <div className="config-manager">
            <span className="service-code-label">КОНФИГУРАЦИЯ</span>
            <div className="config-manager-row">
              <CustomSelect value={selectedConfig} options={configs} onChange={selectConfig} ariaLabel="Выбор конфигурации" className="config-select glass-surface settings-config-dropdown" />
              <button className="glass-icon config-action" type="button" aria-label="Добавить конфигурацию" title="Добавить" onClick={() => openConfigEditor("add")}><Plus size={16} /></button>
              <button className="glass-icon config-action" type="button" aria-label="Редактировать название конфигурации" title="Редактировать" disabled={selectedConfig === "Default"} onClick={() => openConfigEditor("rename")}><Pencil size={15} /></button>
              <button className="glass-icon config-action" type="button" aria-label="Удалить конфигурацию" title="Удалить" disabled={selectedConfig === "Default"} onClick={deleteConfig}><Trash2 size={15} /></button>
            </div>
            {configEditor && <div className="config-name-editor">
              <input autoFocus value={configNameDraft} onChange={(event) => setConfigNameDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") commitConfigName(); if (event.key === "Escape") setConfigEditor(null); }} placeholder={configEditor === "add" ? "Название нового пресета" : "Новое название"} />
              <button type="button" onClick={commitConfigName} aria-label="Подтвердить"><Check size={15} /></button>
              <button type="button" onClick={() => setConfigEditor(null)} aria-label="Отменить"><X size={15} /></button>
            </div>}
          </div>

          <div className="settings-card-heading">
            <div><h2>API-провайдер</h2><p>Подключение сервиса генерации</p></div>
          </div>

          <div className="provider-selector glass-surface">
            {providers.map(({ id, name }) => (
              <button className={provider === id ? "active" : ""} key={id} onClick={() => setProvider(id)}>
                {name}
              </button>
            ))}
          </div>

          <div className="database-source-section">
            <span className="service-code-label">БАЗА КОНТАКТОВ</span>
            <div className="provider-selector database-selector glass-surface">
          <button className={databaseSource === "parser" ? "active" : ""} onClick={() => { setDatabaseSource("parser"); setPreviewPlatform("Depop"); setPreviewGeo("AU"); }}>@vvsparserbot</button>
              <button className={databaseSource === "custom" ? "active" : ""} onClick={() => { setDatabaseSource("custom"); setPreviewPlatform("Custom"); setPreviewGeo(geoOptions[serviceCode][0]); }}>Своя база</button>
            </div>

            {databaseSource === "parser" ? <label className="credential-field database-api-field">
              <span>API @VVSPARSERBOT</span>
              <div className="credential-input"><AtSign size={17} /><input type="password" value={parserApi} onChange={(event) => setParserApi(event.target.value)} placeholder="Введите API-ключ базы" autoComplete="off" /></div>
            </label> : <div className="custom-database-field">
              <span className="settings-label">ПОЧТЫ — КАЖДАЯ С НОВОЙ СТРОКИ</span>
              <div className="database-email-editor">
                <AtSign size={17} />
                <textarea value={customEmails} onChange={(event) => setCustomEmails(event.target.value)} placeholder={"seller@example.com\nclient@example.com\ncontact@example.com"} spellCheck="false" aria-label="Собственная база почт" />
              </div>
              <p className="database-variable-notice">При использовании своей базы переменные объявления подставляться не будут.</p>
              <div className="database-email-count"><strong>{emailCount}</strong><span>почт</span></div>
            </div>}
          </div>

          {provider === "custom" ? <div className="custom-provider-fields">
            <div className="custom-provider-row">
              <label className="credential-field">
                <span>ENDPOINT URL / ДОМЕН</span>
                <div className="credential-input"><Link2 size={17} /><input type="url" value={endpoint} onChange={(event) => { setEndpoint(event.target.value); setCustomCheckStatus("idle"); }} placeholder="https://api.example.com/v1/generate" /></div>
              </label>
              <label className="credential-field">
                <span>ПУТЬ К ССЫЛКЕ В ОТВЕТЕ</span>
                <div className="credential-input"><Route size={17} /><input value={responsePath} onChange={(event) => setResponsePath(event.target.value)} placeholder="data.result.url" /></div>
              </label>
            </div>
            <div className="custom-provider-row buyer-fields">
              <label className="credential-field"><span>ИМЯ ПОКУПАТЕЛЯ</span><div className="credential-input"><UserRound size={17} /><input value={buyerName} onChange={event => setBuyerName(event.target.value)} placeholder="Введите имя покупателя" /></div></label>
              <label className="credential-field"><span>АДРЕС ПОКУПАТЕЛЯ</span><div className="credential-input"><MapPin size={17} /><input value={buyerAddress} onChange={event => setBuyerAddress(event.target.value)} placeholder="Введите адрес покупателя" /></div></label>
            </div>
            <label className="credential-field request-body-field">
              <span>ТЕЛО ЗАПРОСА JSON</span>
              <div className={`variables-hint request-variables-hint ${databaseSource !== "parser" ? "is-disabled" : ""}`} aria-label="Переменные запроса из vvsparserbot">
                <span className="variables-hint-title">ДАННЫЕ @VVSPARSERBOT</span>
                <div><code>{"{ad.title}"}</code><span>название товара</span></div>
                <div><code>{"{ad.image_url}"}</code><span>фотография объявления</span></div>
                <div><code>{"{ad.price}"}</code><span>цена товара</span></div>
                <div><code>{"{ad.name}"}</code><span>имя продавца</span></div>
                <p>Переменные подставляются при выбранной базе @vvsparserbot.</p>
              </div>
              <div className="json-editor"><Braces size={17} /><textarea value={requestBody} onChange={(event) => { setRequestBody(event.target.value); setCustomCheckStatus("idle"); }} placeholder={'{\n  "prompt": "{{message}}"\n}'} spellCheck="false" /></div>
            </label>
            <div className="custom-check-row">
              {customCheckStatus === "valid" && <span className="custom-check-status valid"><CircleCheck size={14} /> Конфигурация корректна</span>}
              {customCheckStatus === "invalid" && <span className="custom-check-status invalid"><CircleAlert size={14} /> Проверьте URL и JSON</span>}
              <GlassButton className="custom-check-button" onClick={checkCustomProvider}>ПРОВЕРИТЬ</GlassButton>
            </div>
          </div> : <div className={`credentials-grid ${provider !== "kartatai" ? "single" : ""}`}>
            <label className="credential-field">
              <span>API КЛЮЧ</span>
              <div className="credential-input"><KeyRound size={17} /><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="Введите ключ доступа" autoComplete="off" /></div>
            </label>
            {provider === "kartatai" && <label className="credential-field">
              <span>TELEGRAM ID</span>
              <div className="credential-input"><UserRound size={17} /><input value={userId} onChange={(event) => setUserId(event.target.value)} placeholder="Например, 123456789" inputMode="numeric" autoComplete="off" /></div>
            </label>}
            {provider === "kartatai" && <label className="credential-field">
              <span>ENDPOINT</span>
              <div className="credential-input"><Link2 size={17} /><input type="url" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="https://api.example.com/v1/generate" autoComplete="off" /></div>
            </label>}
          </div>}

          {provider !== "custom" && <div className="custom-provider-row buyer-fields">
            <label className="credential-field"><span>ИМЯ ПОКУПАТЕЛЯ</span><div className="credential-input"><UserRound size={17} /><input value={buyerName} onChange={event => setBuyerName(event.target.value)} placeholder="Введите имя покупателя" /></div></label>
            <label className="credential-field"><span>АДРЕС ПОКУПАТЕЛЯ</span><div className="credential-input"><MapPin size={17} /><input value={buyerAddress} onChange={event => setBuyerAddress(event.target.value)} placeholder="Введите адрес покупателя" /></div></label>
          </div>}
          {databaseSource === "parser" && <section className="parser-filter-section" aria-label="Параметры фильтрации vvsparserbot">
            <div className="parser-filter-heading">
              <span className="service-code-label">ПАРАМЕТРЫ VVSPARSERBOT</span>
              <span>ФИЛЬТРЫ ОБЪЯВЛЕНИЙ</span>
            </div>
            <div className="parser-filter-grid">
              <label className="parser-filter-field">
                <span>МАКС. ПРОСМОТРОВ · VIEWS</span>
                <input type="number" min="0" value={parserFilters.viewsMax} onChange={(event) => updateParserFilter("viewsMax", event.target.value)} placeholder="Без ограничений" />
              </label>
              <div className="parser-filter-field">
                <span>ОТЗЫВЫ · REVIEWS</span>
                <div className="range-inputs"><input type="number" min="0" value={parserFilters.reviewsMin} onChange={(event) => updateParserFilter("reviewsMin", event.target.value)} placeholder="От" aria-label="Отзывы от" /><i>—</i><input type="number" min="0" value={parserFilters.reviewsMax} onChange={(event) => updateParserFilter("reviewsMax", event.target.value)} placeholder="До" aria-label="Отзывы до" /></div>
              </div>
              <div className="parser-filter-field">
                <span>ПРОДАЖИ · SELLS</span>
                <div className="range-inputs"><input type="number" min="0" value={parserFilters.sellsMin} onChange={(event) => updateParserFilter("sellsMin", event.target.value)} placeholder="От" aria-label="Продажи от" /><i>—</i><input type="number" min="0" value={parserFilters.sellsMax} onChange={(event) => updateParserFilter("sellsMax", event.target.value)} placeholder="До" aria-label="Продажи до" /></div>
              </div>
              <label className="parser-filter-field">
                <span>ПЕРИОД · PUBLICATION</span>
                <div className="publication-input"><input type="number" min="0" value={parserFilters.publicationValue} onChange={(event) => updateParserFilter("publicationValue", event.target.value)} placeholder="Например, 24" /><CustomSelect value={parserFilters.publicationUnit} options={[{ value: "hours", label: "Часов" }, { value: "minutes", label: "Минут" }]} onChange={(value) => updateParserFilter("publicationUnit", value)} ariaLabel="Единица периода публикации" className="settings-unit-dropdown" /></div>
              </label>
              <div className="parser-filter-field">
                <span>ОБЪЯВЛЕНИЯ · ADS</span>
                <div className="range-inputs"><input type="number" min="0" value={parserFilters.adsMin} onChange={(event) => updateParserFilter("adsMin", event.target.value)} placeholder="От" aria-label="Объявления от" /><i>—</i><input type="number" min="0" value={parserFilters.adsMax} onChange={(event) => updateParserFilter("adsMax", event.target.value)} placeholder="До" aria-label="Объявления до" /></div>
              </div>
              <div className="parser-filter-field">
                <span>ЦЕНА · PRICE</span>
                <div className="range-inputs"><input type="number" min="0" step="0.01" value={parserFilters.priceMin} onChange={(event) => updateParserFilter("priceMin", event.target.value)} placeholder="От" aria-label="Цена от" /><i>—</i><input type="number" min="0" step="0.01" value={parserFilters.priceMax} onChange={(event) => updateParserFilter("priceMax", event.target.value)} placeholder="До" aria-label="Цена до" /></div>
              </div>
            </div>
          </section>}

          <div className="service-code-section">
            <span className="service-code-label">КОД СЕРВИСА</span>
            <div className="service-code-list">
              {serviceCodes.map((service) => <button className={serviceCode === service ? "active" : ""} key={service} disabled={(provider === "kartatai" && service === "OLX") || (provider === "eql" && !Object.keys(eqlCategories[service] ?? {}).length)} onClick={() => selectServiceCode(service)}>{service}</button>)}
            </div>
          </div>

          <div className="provider-options-section">
            <div className="provider-option-group">
              <span className="service-code-label">ГЕО · {serviceCode.toUpperCase()} · МОЖНО ВЫБРАТЬ НЕСКОЛЬКО</span>
              <div className="compact-choice-list geo-choice-list">
                {availableServiceGeos.map((geo) => (
                  <button className={selectedGeos.includes(geo) ? "active" : ""} key={geo} disabled={provider === "eql" && !eqlGeoAllowed(serviceCode, geo)} onClick={() => toggleGeo(geo)}>{geo}</button>
                ))}
              </div>
            </div>
            <div className="provider-option-group">
              <span className="service-code-label">РЕЖИМ</span>
              <div className="compact-choice-list">
                <button className={mode === "2.0" ? "active" : ""} disabled={!kartataiModeAllowed("2.0")} onClick={() => setMode("2.0")}>2.0</button>
                <button className={mode === "verif" ? "active" : ""} disabled={!kartataiModeAllowed("verif")} onClick={() => setMode("verif")}>VERIF</button>
              </div>
            </div>
            <div className="provider-option-group workflow-option-group">
              <div className="option-label-with-help">
                <span className="service-code-label">ТИП СЦЕНАРИЯ</span>
                <button
                  className={`workflow-help ${workflowHelpOpen ? "is-open" : ""}`}
                  type="button"
                  aria-label="Описание типов сценария"
                  aria-expanded={workflowHelpOpen}
                  onClick={() => setWorkflowHelpOpen((current) => !current)}
                >
                  <CircleHelp size={15} />
                  <span className="workflow-tooltip" role="tooltip">
                    <strong>Рассылка</strong><span>HTML отправляется первым сообщением.</span>
                    <strong>Воронка</strong><span>Первым отправляется указанный текстовый шаблон, а HTML используется для автоответа.</span>
                  </span>
                </button>
              </div>
              <div className="compact-choice-list">
                <button className={workflowMode === "broadcast" ? "active" : ""} onClick={() => setWorkflowMode("broadcast")}>Рассылка</button>
                <button className={workflowMode === "funnel" ? "active" : ""} onClick={() => setWorkflowMode("funnel")}>Воронка</button>
              </div>
            </div>
          </div>
        </Panel>

        <div className="settings-right-column">
        <Panel className="templates-panel settings-card">
          <div className="settings-card-heading template-heading">
            <span className="settings-heading-icon"><Layers3 size={18} /></span>
            <div><h2>Темы писем</h2><p>По одному варианту темы на каждую строку. Варианты используются по кругу.</p></div>
          </div>
          <div className="variables-hint" aria-label="Переменные темы письма">
            <span className="variables-hint-title">ПЕРЕМЕННЫЕ</span>
            <div><code>{"{item}"}</code><span>название товара</span></div>
            <div><code>{"{name}"}</code><span>имя продавца</span></div>
            <div><code>{"{price}"}</code><span>цена товара</span></div>
          </div>
          <div className="template-editor-wrap">
            <textarea value={subjectLines} onChange={event => setSubjectLines(event.target.value)} placeholder={"Вопрос о {item}\n{item} — уточнение"} aria-label="Варианты темы письма" spellCheck="false" />
            <div className="editor-line" />
          </div>
          <div className="template-footer">
            <div className="template-count"><strong>{subjectLines.split(/\r?\n/).filter(line => line.trim()).length}</strong><span>вариантов темы</span></div>
          </div>
        </Panel>

        <Panel className={`templates-panel settings-card ${workflowMode === "broadcast" ? "is-disabled" : ""}`}>
          <div className="settings-card-heading template-heading">
            <span className="settings-heading-icon"><Layers3 size={18} /></span>
            <div><h2>Шаблоны рассылки</h2><p>По одному варианту сообщения на каждую строку</p></div>
            {workflowMode === "broadcast" && <span className="disabled-mode-badge">НЕДОСТУПНО В РЕЖИМЕ «РАССЫЛКА»</span>}
          </div>

          <fieldset className="template-controls" disabled={workflowMode === "broadcast"}>
          {databaseSource === "parser" && <div className="variables-hint" aria-label="Переменные текстового шаблона">
            <span className="variables-hint-title">ПЕРЕМЕННЫЕ</span>
            <div><code>{"{item}"}</code><span>название товара</span></div>
            <div><code>{"{name}"}</code><span>имя продавца</span></div>
            <div><code>{"{price}"}</code><span>цена товара</span></div>
          </div>}

          <div className="template-editor-wrap">
            <textarea
              aria-label="Тексты шаблонов"
              value={templates[serviceCode]}
              onChange={(event) => updateTemplates(event.target.value)}
              placeholder={"Hello! Is this listing still available?\nHi! I’d like to ask a few details about your offer.\nHello! I’m ready to discuss the purchase whenever it’s convenient for you."}
              spellCheck="true"
            />
            <div className="editor-line" />
          </div>

          <div className="template-footer">
            <div className="template-count"><strong>{templateCount}</strong><span>шаблонов</span></div>
          </div>
          </fieldset>
        </Panel>

        <Panel className="html-preview-card settings-card">
          <div className="settings-card-heading template-heading">
            <span className="settings-heading-icon"><Eye size={18} /></span>
            <div><h2>Выбор HTML-шаблона</h2><p>Визуальная проверка письма перед отправкой</p></div>
          </div>

          <label className="settings-label" htmlFor="preview-platform">ПЛОЩАДКА</label>
          <CustomSelect id="preview-platform" ariaLabel="Площадка HTML-предпросмотра" value={previewPlatform} options={availablePreviewPlatforms} onChange={selectPreviewPlatform} className="platform-select glass-surface settings-platform-dropdown" />
          {previewPlatform !== "Custom" && <>
            <label className="settings-label preview-geo-label" htmlFor="preview-geo">ГЕО</label>
            <CustomSelect id="preview-geo" ariaLabel="Гео HTML-предпросмотра" value={previewGeo} options={availablePreviewGeos} onChange={setPreviewGeo} className="platform-select glass-surface preview-geo-select settings-platform-dropdown" />
          </>}
          {databaseSource === "custom" && <p className="html-custom-only-note">При выборе своей базы доступен только Custom HTML-шаблон.</p>}

          {previewPlatform === "Custom" && <label className="html-code-field">
            <span className="settings-label">HTML-КОД</span>
            {databaseSource === "parser" && <div className="variables-hint html-variables-hint" aria-label="Переменные HTML-шаблона">
              <span className="variables-hint-title">ПЕРЕМЕННЫЕ</span>
              <div><code>{"{item}"}</code><span>название предмета</span></div>
              <div><code>{"{name}"}</code><span>имя продавца</span></div>
              <div><code>{"{price}"}</code><span>цена товара</span></div>
              <div><code>{"{link}"}</code><span>ссылка из провайдера</span></div>
              <div><code>{"{data}"}</code><span>дата в формате 01.12.2026</span></div>
            </div>}
            <div className="html-code-editor">
              <Code2 size={17} />
              <textarea value={customHtml} onChange={(event) => setCustomHtml(event.target.value)} spellCheck="false" aria-label="HTML-код пользовательского шаблона" />
            </div>
          </label>}

          <span className="settings-label preview-label">ПРЕДПРОСМОТР</span>
          <div className="html-preview-frame">
            <iframe
              title={`Предпросмотр ${previewPlatform}`}
              sandbox=""
              srcDoc={previewPlatform === "Custom"
                ? customHtml
                : htmlTemplates[`../templates/html/${previewPlatform.toLowerCase()}/${previewGeo.toUpperCase()}/template.html`] ?? ""}
            />
          </div>
        </Panel>
        </div>
      </div>
    </div>
  );
}
