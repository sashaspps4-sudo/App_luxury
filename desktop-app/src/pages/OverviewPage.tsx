import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { Bot, Check, CircleDot, MessageSquareText, Play, Plus, X, Send, Settings2, Square, Terminal } from "lucide-react";
import { defaultProfiles, deleteProfile, loadProfiles, saveProfiles, type ProfileStore } from "../profileStore";
import { Panel } from "../components/ui";
import { CustomSelect } from "../components/CustomSelect";
import { loadSettingsStore, saveSettingsStore } from "../settingsPersistence";
import { fetchParserBatch, saveInboxBaseline, syncDesktopProfiles, type InboxSnapshot } from "../licenseApi";
import { broadcastAsset } from "../broadcastAssets";
import { flushAutomation } from "../automationSettings";
import { accountStatus } from "../accountStatus";
import { sessionState, sessionElapsed, type SessionRun } from "../sessionState";

type LogEntry = { time: string; message: string; kind: "system" | "action" | "success" | "error" };
type ConsoleFilter = "all" | "events" | "success" | "errors";
type BrowserStatus = { index: number; id?: string; status: string; message: string; sent?: number; campaignPhase?: string };
type ActiveRun = SessionRun & { runId: string; configName: string; mode: "broadcast" | "funnel" };

function currentTime() {
  return new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date());
}

function profileLabel(index: number) {
  return `Профиль ${String(index + 1).padStart(2, "0")}`;
}

export function OverviewPage() {
  const [busy, setBusy] = useState(false);
  const [statuses, setStatuses] = useState<BrowserStatus[]>([]);
  const [sentCounts, setSentCounts] = useState<Record<string, number>>({});
  const [replyCounts, setReplyCounts] = useState<Record<string, { received: number; autoSent: number }>>({});
  const [statsLoaded, setStatsLoaded] = useState(false);
  const [activeRun, setActiveRun] = useState<ActiveRun | null>(null);
  const [sessionRun, setSessionRun] = useState<ActiveRun | null>(null);
  const [sessionOperation, setSessionOperation] = useState<string | null>(null);
  const [sessionNow, setSessionNow] = useState(Date.now);
  useEffect(() => {
    if (!sessionRun || sessionRun.endedAtMs != null) return;
    setSessionNow(Date.now());
    const timer = window.setInterval(() => setSessionNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [sessionRun?.runId, sessionRun?.endedAtMs]);
  const statusVersion = useRef(0);
  const statusLocked = useRef(false);
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let previous = "";
    let previousEntries: typeof statuses = [];
    let polling = false;
    const poll = async () => {
      if (polling || statusLocked.current) return;
      polling = true;
      const version = statusVersion.current;
      try {
        const next = await invoke<typeof statuses>("browser_status");
        if (disposed || version !== statusVersion.current) return;
        const events = await invoke<Array<{ index: number; level: string; message: string }>>("campaign_events");
        if (events.length && !disposed) setLogs(current => [...events.reverse().map(event => ({ time: currentTime(), message: `${event.level === "error" ? "ERROR" : event.level === "success" ? "SUCCESS" : "INFO"} Аккаунт № ${String(event.index + 1).padStart(2, "0")}: ${event.message}`, kind: event.level === "error" ? "error" as const : event.level === "success" ? "success" as const : "action" as const })), ...current].slice(0, 500));
        const run = await invoke<(ActiveRun & { parserComplete: boolean }) | null>("active_browser_run");
        if (disposed || version !== statusVersion.current) return;
        const hasOpen = next.some(item => !["closed", "error"].includes(item.status));
        const campaignActive = next.some(item => accountStatus(item).className === "ready");
        setSessionRun(run);
        setActiveRun(hasOpen ? run : null);
        if (!hasOpen) setLaunchStage("idle");
        if (campaignActive) setLaunchStage("running");
        else if (run && next.some(item => item.status === "ready") && next.every(item => ["ready", "closed", "error"].includes(item.status))) {
          setLaunchStage(run.parserComplete ? "running" : "preparing");
        }
        if (JSON.stringify(next) === previous) return;
        previous = JSON.stringify(next);
        setStatuses(next);
        const changed = next.filter(item => JSON.stringify(item) !== JSON.stringify(previousEntries.find(old => old.index === item.index)));
        previousEntries = next;
        setLogs(current => [...changed.filter(item => item.message || item.status === "closed").map(item => ({ time: currentTime(), message: `${profileLabel(item.index)}: ${item.message || "Браузер закрыт."}`, kind: item.message ? "error" as const : "system" as const })), ...current].slice(0, 200));
        if (next.length && next.every(item => item.status === "closed" || item.status === "error")) { setLaunchStage("idle"); setActiveRun(null); }
        else if (!campaignActive && next.some(item => ["open", "starting", "checking", "unready"].includes(item.status))) setLaunchStage("preparing");
      } catch { /* Launch commands report connection errors. */ }
      finally { polling = false; }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 700);
    return () => { disposed = true; window.clearInterval(timer); };
  }, []);
  const [launchStage, setLaunchStage] = useState<"idle" | "preparing" | "running">("idle");
  const [store, setStore] = useState<ProfileStore>(defaultProfiles);
  const [profilesReady, setProfilesReady] = useState(false);
  const [saveState, setSaveState] = useState("");
  const [statsError, setStatsError] = useState("");
  const profiles = store.profiles;
  useEffect(() => {
    if (!profilesReady) return;
    let disposed = false;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const result = await syncDesktopProfiles(store.profiles, store.deletedIds);
        if (!disposed) {
          setSentCounts(Object.fromEntries(result.profiles.map(profile => [profile.id, profile.sent])));
          setReplyCounts(Object.fromEntries(result.profiles.map(profile => [profile.id, { received: profile.received ?? 0, autoSent: profile.auto_sent ?? 0 }])));
          setStatsLoaded(true);
          setStatsError("");
        }
      } catch (error) { if (!disposed) setStatsError(`Счётчики не обновлены: ${String(error)}`); }
      finally { pending = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [store, profilesReady]);
  useEffect(() => {
    let disposed = false;
    void loadProfiles().then(value => { if (!disposed) { setStore(value); setProfilesReady(true); } }).catch(error => {
      if (!disposed) setSaveState(String(error));
    });
    return () => { disposed = true; };
  }, []);
  function persist(next: ProfileStore, message = "") {
    setStore(next);
    setSaveState("saving");
    void saveProfiles(next).then(() => setSaveState(message)).catch(error => setSaveState(String(error)));
  }
  function addProfile() {
    if (!profilesReady || busy || launchStage !== "idle" || profiles.length >= 20) return;
    persist({ ...store, profiles: [...profiles, { id: crypto.randomUUID(), proxy: "" }], nextId: store.nextId + 1 }, "Профиль добавлен");
    setStatuses([]);
  }
  async function removeProfile(id: string) {
    if (!profilesReady || busy || launchStage !== "idle") return;
    setBusy(true);
    setSaveState("saving");
    const next = { ...store, profiles: profiles.filter(profile => profile.id !== id), deletedIds: [...(store.deletedIds ?? []), id] };
    try {
      await deleteProfile(id, next);
      setStore(next);
      setStatuses([]);
      setSaveState("Профиль удалён");
      setLogs(current => [{ time: currentTime(), message: `${profileLabel(profiles.findIndex(profile => profile.id === id))}: профиль и данные входа удалены.`, kind: "system" }, ...current]);
    } catch (error) {
      setSaveState(String(error));
      setLogs(current => [{ time: currentTime(), message: String(error), kind: "error" }, ...current]);
    } finally { setBusy(false); }
  }
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [configNames, setConfigNames] = useState<string[]>([]);
  const [selectedConfig, setSelectedConfig] = useState("");
  const [configPending, setConfigPending] = useState(false);
  const [configError, setConfigError] = useState("");
  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const saved = await loadSettingsStore();
        if (disposed) return;
        setConfigNames(Object.keys(saved.configs));
        setSelectedConfig(saved.selectedConfig);
        setConfigError("");
      } catch (error) { if (!disposed) setConfigError(String(error)); }
    };
    void refresh();
    window.addEventListener("luxury-settings-saved", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      disposed = true;
      window.removeEventListener("luxury-settings-saved", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [settingsOpen]);
  async function selectLaunchConfig(name: string) {
    if (busy || configPending || launchStage !== "idle") return;
    setConfigPending(true);
    try {
      const saved = await loadSettingsStore();
      if (!saved.configs[name]) throw new Error("Конфиг больше не существует. Выберите другой.");
      await saveSettingsStore({ ...saved, selectedConfig: name });
      setSelectedConfig(name);
      setConfigError("");
    } catch (error) { setConfigError(String(error)); }
    finally { setConfigPending(false); }
  }
  const [consoleFilter, setConsoleFilter] = useState<ConsoleFilter>("all");
  const [logs, setLogs] = useState<LogEntry[]>([{ time: currentTime(), message: "Панель готова. Ожидание запуска.", kind: "system" }]);
  const profileCount = profiles.length;

  async function advanceLaunch() {
    if (busy || configPending || statusLocked.current) return;
    statusLocked.current = true;
    statusVersion.current++;
    setBusy(true);
    try {
      if (!isTauri()) throw new Error("Запуск браузеров доступен в desktop-приложении.");
      await syncDesktopProfiles(store.profiles, store.deletedIds);
      await flushAutomation();
      if (launchStage === "preparing") {
        setSessionOperation("Проверяем аккаунты");
        const checked = await invoke<BrowserStatus[]>("check_accounts");
        setStatuses(checked);
        const opened = checked.filter(item => !["closed", "error"].includes(item.status));
        const ready = opened.filter(item => item.status === "ready").length;
        setLaunchStage(opened.length === 0 ? "idle" : "preparing");
        if (!opened.length) setActiveRun(null);
        setLogs(current => [
          { time: currentTime(), message: "Готовность аккаунтов проверена.", kind: "system" },
          { time: currentTime(), message: `Готовы: ${ready} из ${opened.length} открытых аккаунтов.`, kind: "system" },
          ...checked.filter(item => item.message).map(item => ({ time: currentTime(), message: `${profileLabel(item.index)}: ${item.message}`, kind: "error" as const })),
          ...current,
        ]);
        if (opened.length && ready === opened.length) {
          if (!activeRun) throw new Error("Не найден текущий запуск. Закройте браузеры и запустите их снова.");
          setLogs(current => [
            ...opened.map(profile => ({ time: currentTime(), message: `INFO ${profileLabel(profile.index)}: проверяем #inbox и снимаем отпечаток входящих.`, kind: "action" as const })),
            ...current,
          ]);
          setSessionOperation("Проверяем входящие");
          const inboxes = await invoke<{ run_id: string; profiles: InboxSnapshot[] }>("sync_inboxes", { runId: activeRun.runId });
          for (const snapshot of inboxes.profiles) {
            const profile = opened.find(profile => profile.id === snapshot.profile_id);
            const label = profile ? profileLabel(profile.index) : `Профиль ${snapshot.profile_id}`;
            setLogs(current => [{ time: currentTime(), message: `INFO ${label}: входящие проверены, страниц: ${snapshot.pages}. Сверяем отправителей.`, kind: "action" }, ...current]);
            const receipt = await saveInboxBaseline(inboxes.run_id, snapshot);
            setLogs(current => [
              { time: currentTime(), message: `INFO ${label}: сверка отправителей с объявлениями завершена. Кандидатов для автоответа: ${receipt.matched}; требуют проверки: ${receipt.needs_review}; без совпадений: ${receipt.unmatched}; уже обработаны или в работе: ${receipt.already_processed}.`, kind: "system" },
              { time: currentTime(), message: `INFO ${label}: учтено переписок: ${receipt.count}; известных: ${receipt.seen_before}; новых: ${receipt.added}; пропущено писем Google: ${receipt.ignored}.`, kind: "system" },
              ...current,
            ]);
          }
          await invoke("confirm_inbox_baseline", { runId: activeRun.runId });
          const selection = await invoke<{ mode: string; platform: string; geo: string }>("campaign_template", { runId: activeRun.runId });
          const html = selection.platform !== "Custom" ? broadcastAsset(selection.platform, selection.geo) : null;
          setSessionOperation("Получаем объявления");
          const prepared = await invoke<{ source: string; request?: Record<string, unknown> }>("prepare_parser_batch", { runId: activeRun.runId });
          if (prepared.source === "parser" && prepared.request) {
            const result = await fetchParserBatch(prepared.request, info => {
              const platform = info.platform === "olx" ? "OLX" : info.platform.charAt(0).toUpperCase() + info.platform.slice(1);
              setLogs(current => [{ time: currentTime(), message: `INFO Запрос к @vvsparserbot — ${platform}; лимит ${info.limit}; параметры: ${JSON.stringify(info.params)}`, kind: "action" }, ...current]);
            });
            setLogs(current => [{ time: currentTime(), message: `INFO Ответ @vvsparserbot — ${result.returned === undefined ? "" : `объявлений: ${result.returned} шт.; `}с уникальными email: ${result.received} из ${result.requested} шт.${result.shortfall ? ` Не хватает: ${result.shortfall} шт.` : ""}`, kind: "system" }, ...current]);
            await invoke("store_parser_batch", { result });
            setLogs(current => [
              ...result.batches.map(batch => ({ time: currentTime(), message: `Профиль ID ${batch.profile_id}: получено ${batch.ads.length} из ${(prepared.request?.profile_limits as Record<string, number> | undefined)?.[batch.profile_id] ?? 10} объявлений.`, kind: "system" as const })),
              ...current,
            ]);
          } else {
            setLogs(current => [{ time: currentTime(), message: "Выбрана собственная база: запрос к парсеру не требуется.", kind: "system" }, ...current]);
            throw new Error("Отправка собственной базы пока не подключена. Для этого запуска используйте объявления из парсера.");
          }
          setSessionOperation("Запускаем рассылку");
          await invoke("start_campaign", { runId: activeRun.runId, html });
          setLogs(current => [{ time: currentTime(), message: "INFO Рассылка запущена для готовых аккаунтов.", kind: "system" }, ...current]);
          setSessionRun(current => current ? { ...current, campaignStarted: true } : current);
          setLaunchStage("running");
        }
      } else if (launchStage === "running") {
        setSessionOperation("Останавливаем сессию");
        await invoke("stop_browsers");
        setSessionRun(current => current ? { ...current, stopRequested: true } : current);
        setLogs(current => [{ time: currentTime(), message: "Закрываем браузеры и сохраняем сессии профилей.", kind: "system" }, ...current]);
      } else {
        if (!profilesReady || !profiles.length) { setSettingsOpen(true); return; }
        if (!selectedConfig || configError) throw new Error("Выберите доступный конфиг рассылки.");
        const saved = await loadSettingsStore();
        if (!saved.configs[selectedConfig]) throw new Error("Выбранный конфиг удалён. Выберите другой.");
        // Materialize the default config too; the native side captures this file.
        await saveSettingsStore({ ...saved, selectedConfig });
        await saveProfiles(store);
        setSessionOperation("Открываем браузеры");
        const run = await invoke<ActiveRun>("start_browsers", { profiles, configName: selectedConfig });
        setSessionRun(run);
        setSessionNow(Date.now());
        setActiveRun(run);
        setStatuses(profiles.map((profile, index) => ({ index, id: profile.id, status: "starting", message: "" })));
        setLaunchStage("preparing");
        setLogs(current => [{ time: currentTime(), message: `Конфиг «${run.configName}» закреплён за запуском. Открываем Gmail в отдельных воркерах.`, kind: "system" }, ...current]);
      }
    } catch (error) {
      setLogs(current => [{ time: currentTime(), message: error instanceof Error ? error.message : String(error), kind: "error" }, ...current]);
    } finally { statusVersion.current++; statusLocked.current = false; setBusy(false); setSessionOperation(null); }
  }

  function updateProxy(index: number, value: string) {
    persist({ ...store, profiles: profiles.map((profile, itemIndex) => itemIndex === index ? { ...profile, proxy: value } : profile) });
  }

  const filteredLogs = logs.filter((entry) => consoleFilter === "all" || (consoleFilter === "errors" ? entry.kind === "error" : consoleFilter === "success" ? entry.kind === "success" : entry.kind === "action" || entry.kind === "system"));

  return <div className="overview-page">
    <section className="overview-heading">
      <div><p className="kicker">WORKSPACE / CONTROL</p><h1>Панель <span>запуска</span></h1><p>Профили, отправки и текущие действия в одном окне.</p></div>
      <div className="overview-actions">
        <button type="button" className="glass-button overview-settings-button" onClick={() => setSettingsOpen((open) => !open)} aria-expanded={settingsOpen}><Settings2 size={17} /><span>Настройки профилей</span><b>{profileCount}</b></button>
        <button type="button" disabled={busy || configPending || !profilesReady || !profiles.length} className={`primary-button overview-launch-button${launchStage === "preparing" ? " is-ready" : launchStage === "running" ? " is-running" : ""}`} onClick={() => void advanceLaunch()}>
          {launchStage === "preparing" ? <><Check size={16} />АККАУНТЫ ГОТОВЫ</> : launchStage === "running" ? <><Square size={15} />ОСТАНОВИТЬ</> : <><Play size={16} />ЗАПУСТИТЬ РАССЫЛКУ</>}
        </button>
      </div>
    </section>

    {settingsOpen && <Panel className="overview-settings-panel">
      <div className="overview-panel-heading"><div><p className="kicker">ПАРАМЕТРЫ ЗАПУСКА</p><h2>Профили и прокси</h2><p>Добавляй профили кнопкой «+». Пустое поле прокси — прямое подключение.</p></div><button type="button" className="glass-button profile-add-button" onClick={addProfile} disabled={!profilesReady || busy || launchStage !== "idle" || profiles.length >= 20}><Plus size={17} />Добавить профиль</button></div>
      <div className="overview-profile-options">
        <CustomSelect label="КОНФИГ РАССЫЛКИ" ariaLabel="Конфиг рассылки" value={activeRun?.configName ?? (selectedConfig || "Загрузка…")} options={configNames} onChange={name => void selectLaunchConfig(name)} disabled={busy || configPending || launchStage !== "idle" || !configNames.length} className="overview-config-select" />
        <span className="proxy-type-note"><b>SOCKS5</b><span>Прокси сохраняется автоматически</span></span>
      </div>
      {configError && <p className="profile-save-state" role="alert">{configError}</p>}
      <div className="profile-save-state" role="status">{!profilesReady ? saveState || "Загрузка профилей…" : saveState === "saving" ? "" : saveState}</div>
      <div className="profile-proxy-grid">{profiles.map((profile, index) => <div className="profile-proxy-card" key={profile.id}><div className="profile-proxy-card-heading"><strong>{profileLabel(index)}</strong><button type="button" className="glass-icon profile-remove-button" aria-label={`Удалить ${profileLabel(index)}`} title="Удалить профиль и данные входа с диска" onClick={() => removeProfile(profile.id)} disabled={!profilesReady || busy || launchStage !== "idle"}><X size={15} /></button></div><label className="profile-proxy-field"><span>SOCKS5-ПРОКСИ · НЕОБЯЗАТЕЛЬНО</span><input disabled={!profilesReady || busy || launchStage !== "idle"} maxLength={2048} value={profile.proxy} onChange={(event) => updateProxy(index, event.target.value)} placeholder="socks5://login:password@host:port" /></label></div>)}</div>
      {profilesReady && !profiles.length && <p className="overview-console-empty">Профилей пока нет. Нажми «Добавить профиль», чтобы начать.</p>}
    </Panel>}

    <section className="overview-metrics" aria-label="Итоги по добавленным аккаунтам">
      <Panel className="overview-metric"><div className="overview-metric-title"><span>ОТПРАВЛЕНО</span><Send size={16} /></div><strong>{statsLoaded ? profiles.reduce((total, profile) => total + (sentCounts[profile.id] ?? 0), 0) : "…"}</strong><small>Всего по добавленным аккаунтам</small></Panel>
      <Panel className="overview-metric"><div className="overview-metric-title"><span>ПОЛУЧЕНО</span><MessageSquareText size={16} /></div><strong>{statsLoaded ? profiles.reduce((total, profile) => total + (replyCounts[profile.id]?.received ?? 0), 0) : "…"}</strong><small>Подтверждённые ответы продавцов из базы</small></Panel>
      <Panel className="overview-metric"><div className="overview-metric-title"><span>ОТПРАВЛЕНО АВТООТВЕТОВ</span><Bot size={16} /></div><strong>{statsLoaded ? profiles.reduce((total, profile) => total + (replyCounts[profile.id]?.autoSent ?? 0), 0) : "…"}</strong><small>Подтверждённые отправки</small></Panel>
    </section>

    {statsError && <p className="profile-save-state" role="status">{statsError}</p>}
    <Panel className="overview-accounts-panel">
      <div className="overview-accounts-header"><div><div className="overview-console-title"><CircleDot size={16} /><h2>Аккаунты</h2></div><p>{launchStage === "idle" ? "При запуске откроются профили для входа в аккаунты." : launchStage === "preparing" ? "Войди в аккаунты в открытых браузерах. Сессии сохраняются в профилях." : "Очереди профилей запущены. Результаты отправки отображаются в журнале."}</p></div><span>Профилей: {profileCount}</span></div>
      <div className="overview-account-table">
        <div className="overview-account-row overview-account-labels"><span>АККАУНТ</span><span>СТАТУС</span><span>ОТПРАВЛЕНО ПИСЕМ</span></div>
        {profiles.map((profile, index) => {
          const worker = statuses.find(item => item.id === profile.id);
          const status = accountStatus(worker);
          return <div className="overview-account-row" key={profile.id}><div className="overview-account-name"><span>{String(index + 1).padStart(2, "0")}</span><strong>Аккаунт № {String(index + 1).padStart(2, "0")}</strong></div><span className={`profile-status ${status.className}`}><i />{status.label}</span><strong className="overview-account-sent">{statsLoaded ? sentCounts[profile.id] ?? 0 : "…"}</strong></div>;
        })}
      </div>
    </Panel>

    <Panel className="overview-console-panel">
      <div className="overview-console-header"><div><div className="overview-console-title"><Terminal size={17} /><h2>Консоль действий</h2></div><p>События и состояние текущего запуска</p></div><span className={`overview-connection${launchStage === "running" ? " active" : ""}`}><CircleDot size={12} />{launchStage === "idle" ? "ОЖИДАНИЕ" : launchStage === "preparing" ? "ПОДГОТОВКА" : "ГОТОВЫ"}</span></div>
      <div className="overview-run-state"><div><span>СОСТОЯНИЕ СЕССИИ</span><strong>{sessionState(sessionRun, statuses, sessionOperation)}</strong></div><div><span>ВРЕМЯ РАБОТЫ</span><strong>{sessionElapsed(sessionRun, sessionNow)}</strong></div><div><span>ПРОФИЛЕЙ</span><strong>{profileCount}</strong></div></div>
      <div className="overview-console-toolbar"><span>ЖУРНАЛ СОБЫТИЙ</span><div role="group" aria-label="Фильтр консоли">{([["all", "Все"], ["events", "События"], ["success", "Успешно"], ["errors", "Ошибки"]] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={consoleFilter === value} className={`${consoleFilter === value ? "active" : ""} ${value === "success" ? "success-filter" : ""}`} onClick={() => setConsoleFilter(value)}>{label}{value === "errors" && logs.filter((entry) => entry.kind === "error").length > 0 && <b>{logs.filter((entry) => entry.kind === "error").length}</b>}</button>)}</div></div>
      <div className="overview-console" role="log" aria-live="polite">{filteredLogs.map((entry, index) => <div className={`overview-log-line ${entry.kind}`} key={`${entry.time}-${index}`}><time>{entry.time}</time><span>{entry.message}</span></div>)}{filteredLogs.length === 0 && <p className="overview-console-empty">{consoleFilter === "success" ? "Успешных действий пока нет" : consoleFilter === "errors" ? "Ошибок пока нет" : "Событий пока нет"}</p>}</div>
    </Panel>
  </div>;
}
