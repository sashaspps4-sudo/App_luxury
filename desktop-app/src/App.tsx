import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { BarChart3, CircleHelp, LayoutDashboard, LogOut, Menu, Settings, Workflow, Zap } from "lucide-react";
import { WindowChrome } from "./components/ui";
import { SplashScreen } from "./components/SplashScreen";
import { GlowCursor } from "./components/GlowCursor";
import { SettingsPage } from "./pages/SettingsPage";
import { AnalyticsPage } from "./pages/AnalyticsPage";
import { OverviewPage } from "./pages/OverviewPage";
import { AutomationPage } from "./pages/AutomationPage";
import { LicenseLoginPage } from "./pages/LicenseLoginPage";
import { activateLicense, clearLicenseSession, fetchTelegramAvatar, LicenseApiError, LicenseAccount, restoreLicenseSession, validateLicenseSession, stopLicensedScenarios } from "./licenseApi";
import { startLicenseMonitor } from "./sessionLifecycle";
import luxuryMark from "./assets/luxury-emblem.png";

const navigation = [
  { id: "overview", label: "Обзор", icon: LayoutDashboard },
  { id: "automation", label: "Автоматизация", icon: Workflow },
];
const tools = [
  { id: "analytics", label: "Аналитика", icon: BarChart3 },
  { id: "settings", label: "Настройки", icon: Settings },
];

const planTitles: Record<LicenseAccount["plan"], string> = {
  day: "DAY PLAN",
  week: "WEEK PLAN",
  month: "MONTH PLAN",
};
const planDurations: Record<LicenseAccount["plan"], number> = {
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
};

function remainingLabel(plan: LicenseAccount["plan"], expiresAt: string, now: number): string {
  const remaining = Math.max(0, Date.parse(expiresAt) - now);
  if (remaining <= 0) return "0 МИНУТ";
  if (plan === "day" || remaining < 24 * 60 * 60 * 1000) {
    const minutes = Math.ceil(remaining / 60_000);
    if (minutes < 60) return `${minutes} МИНУТ`;
    const hours = Math.ceil(minutes / 60);
    return `${hours} ${hours === 1 ? "ЧАС" : "ЧАСОВ"}`;
  }
  const days = Math.ceil(remaining / (24 * 60 * 60 * 1000));
  const suffix = days === 1 ? "ДЕНЬ" : days >= 2 && days <= 4 ? "ДНЯ" : "ДНЕЙ";
  return `${days} ${suffix}`;
}

function App() {
  const [active, setActive] = useState("overview");
  const [account, setAccount] = useState<LicenseAccount | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authNotice, setAuthNotice] = useState("");
  const [authUnavailable, setAuthUnavailable] = useState("");
  const [authAttempt, setAuthAttempt] = useState(0);
  const [connectionNotice, setConnectionNotice] = useState("");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [logoutPending, setLogoutPending] = useState(false);
  const [now, setNow] = useState(Date.now());
  const mainPanelRef = useRef<HTMLElement>(null);
  const profileMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!profileMenuOpen) return;
    const closeOnOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !profileMenuRef.current?.contains(event.target)) setProfileMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setProfileMenuOpen(false); };
    document.addEventListener("pointerdown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [profileMenuOpen]);

  useEffect(() => {
    let mounted = true;
    setAuthReady(false);
    setAuthUnavailable("");
    void restoreLicenseSession()
      .then((restored) => { if (mounted) setAccount(restored); })
      .catch((error: unknown) => {
        if (mounted) setAuthUnavailable("Бэкенд недоступен. Не удалось проверить подписку. Сохранённая сессия не удалена — повторите проверку после восстановления связи.");
      })
      .finally(() => { if (mounted) setAuthReady(true); });
    return () => { mounted = false; };
  }, [authAttempt]);

  useEffect(() => {
    if (!authUnavailable) return;
    const retry = () => setAuthAttempt(value => value + 1);
    const timer = window.setInterval(retry, 30_000);
    window.addEventListener("online", retry);
    return () => { window.clearInterval(timer); window.removeEventListener("online", retry); };
  }, [authUnavailable]);

  useEffect(() => {
    if (!account) {
      setAvatarUrl(null);
      return;
    }
    let mounted = true;
    let objectUrl: string | null = null;
    void fetchTelegramAvatar(account.token).then((url) => {
      objectUrl = url;
      if (mounted) setAvatarUrl(url);
      else if (url) URL.revokeObjectURL(url);
    });
    return () => {
      mounted = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [account?.token]);

  useEffect(() => {
    if (!account) return;
    const monitor = startLicenseMonitor(account, {
      validate: validateLicenseSession,
      denied: error => error instanceof LicenseApiError && (error.status === 401 || error.status === 403),
      stop: stopLicensedScenarios,
      clear: clearLicenseSession,
      updated: refreshed => setAccount(current => current?.token === refreshed.token ? refreshed : current),
      unavailable: setConnectionNotice,
      busy: setLogoutPending,
      ended: error => {
        setProfileMenuOpen(false);
        setAccount(null);
        setConnectionNotice("");
        setAuthNotice(error instanceof LicenseApiError && error.status === 403
          ? "Подписка закончилась. Войдите снова после её продления."
          : "Сессия завершена. Введите лицензионный ключ снова.");
      },
    });
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    const onFocus = () => void monitor.check();
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onFocus);
    return () => {
      monitor.dispose();
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onFocus);
    };
  }, [account?.token]);

  useLayoutEffect(() => {
    if (mainPanelRef.current) mainPanelRef.current.scrollTop = 0;
  }, [active]);

  const handleActivate = async (licenseKey: string) => {
    const nextAccount = await activateLicense(licenseKey);
    setAuthNotice("");
    setAccount(nextAccount);
  };

  const handleLogout = async () => {
    if (logoutPending) return;
    setLogoutPending(true);
    try {
      await stopLicensedScenarios();
      await clearLicenseSession(account?.token);
      setProfileMenuOpen(false);
      setAvatarUrl(null);
      setAccount(null);
      setAuthNotice("Вы вышли из аккаунта.");
    } catch {
      setAuthNotice("Не удалось завершить локальную сессию. Попробуйте ещё раз.");
    } finally {
      setLogoutPending(false);
    }
  };

  if (!authReady || authUnavailable) {
    return (
      <div className="desktop-stage">
        <SplashScreen />
        <main className="license-screen license-check-screen">
          <WindowChrome />
          <div className="license-checking">{!authReady && <span className="license-check-spinner" />}<strong>{authUnavailable ? "Бэкенд недоступен" : "Проверяем доступ"}</strong><small>{authUnavailable || "Связываемся с сервером лицензий"}</small>{authUnavailable && <button className="glass-button" onClick={() => setAuthAttempt(value => value + 1)}>Повторить проверку</button>}</div>
        </main>
      </div>
    );
  }

  return (
    <div className="desktop-stage">
      <GlowCursor />
      <SplashScreen />
      {account ? <>
        <div className="ambient ambient-one" /><div className="ambient ambient-two" />
        <div className={`app-frame ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
          <WindowChrome />
          <aside className="sidebar">
            <div className="brand-row"><div className="brand-symbol"><img src={luxuryMark} alt="" /></div><span>Luxury</span><button className="glass-icon collapse-button" aria-label={sidebarCollapsed ? "Развернуть меню" : "Свернуть меню"} title={sidebarCollapsed ? "Развернуть меню" : "Свернуть меню"} aria-expanded={!sidebarCollapsed} onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}><Menu size={15} /></button></div>
            <div className="workspace-profile-anchor" ref={profileMenuRef}>
              <button className={`workspace-switch glass-surface ${profileMenuOpen ? "open" : ""}`} aria-label="Открыть меню профиля" aria-haspopup="dialog" aria-expanded={profileMenuOpen} onClick={() => setProfileMenuOpen((open) => !open)}><span className={`workspace-avatar ${avatarUrl ? "has-image" : ""}`} aria-hidden="true">{avatarUrl && <img src={avatarUrl} alt="" />}</span><span className="workspace-profile-copy"><strong>{account.telegramUsername ? `@${account.telegramUsername}` : `ID ${account.telegramId}`}</strong><small>{account.telegramId}</small></span></button>
              {profileMenuOpen && <div className="workspace-profile-popover glass-surface" role="dialog" aria-label="Профиль пользователя"><div className="workspace-profile-summary"><span className={`workspace-profile-avatar ${avatarUrl ? "has-image" : ""}`}>{avatarUrl ? <img src={avatarUrl} alt="" /> : null}</span><div><strong>{account.telegramUsername ? `@${account.telegramUsername}` : "Telegram-профиль"}</strong><small>ID {account.telegramId}</small></div></div><button className="workspace-logout-button" disabled={logoutPending} onClick={() => void handleLogout()}><LogOut size={15} /><span>{logoutPending ? "Выходим…" : "Выйти из аккаунта"}</span></button></div>}
            </div>
            <nav className="sidebar-nav" aria-label="Основное меню">
              <p className="section-label">WORKSPACE</p>
              {navigation.map(({ id, label, icon: Icon }) => <button className={`nav-link ${active === id ? "active" : ""}`} key={id} onClick={() => setActive(id)}><Icon size={16} /><span>{label}</span></button>)}
              <p className="section-label tools-label">TOOLS</p>
              {tools.map(({ id, label, icon: Icon }) => <button className={`nav-link ${active === id ? "active" : ""}`} key={id} onClick={() => setActive(id)}><Icon size={16} /><span>{label}</span></button>)}
            </nav>
            <div className="sidebar-footer">
              <button className="support-button glass-surface"><CircleHelp size={15} /> Поддержка</button>
              <div className="plan-card"><div><Zap size={16} /><span>{planTitles[account.plan]}</span></div><strong className="subscription-days">{remainingLabel(account.plan, account.expiresAt, now)}</strong><div className="plan-track"><i style={{ width: `${Math.min(100, Math.max(0, ((Date.parse(account.expiresAt) - now) / planDurations[account.plan]) * 100))}%` }} /></div><small>Осталось до окончания подписки</small></div>
            </div>
          </aside>
          <main className="main-panel" ref={mainPanelRef}>
            <div className="content" inert={logoutPending}>
              {connectionNotice && <p className="session-connection-notice" role="status">{connectionNotice}</p>}
              <div className={`tab-view ${active === "overview" ? "is-active" : ""}`} hidden={active !== "overview"}><OverviewPage /></div>
              {active !== "overview" && <div className="tab-view is-active" key={active}>
                {active === "settings" ? <SettingsPage /> : active === "analytics" ? <AnalyticsPage /> : <AutomationPage />}
              </div>}
            </div>
          </main>
        </div>
      </> : <LicenseLoginPage onActivate={handleActivate} notice={authNotice} />}
    </div>
  );
}

export default App;
