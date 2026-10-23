import type { LicenseAccount } from "./licenseApi";

type Clock = {
  now(): number;
  setTimeout(callback: () => void, delay: number): number;
  clearTimeout(id: number | undefined): void;
  setInterval(callback: () => void, delay: number): number;
  clearInterval(id: number): void;
};
export function startLicenseMonitor(account: LicenseAccount, hooks: {
  validate(token: string): Promise<LicenseAccount>;
  denied(error: unknown): boolean;
  stop(): Promise<void>;
  clear(): Promise<void>;
  updated(account: LicenseAccount): void;
  ended(error: unknown): void;
  unavailable(message: string): void;
  busy(value: boolean): void;
}, clock: Clock = { now: Date.now, setTimeout: (fn, ms) => window.setTimeout(fn, ms), clearTimeout: id => window.clearTimeout(id), setInterval: (fn, ms) => window.setInterval(fn, ms), clearInterval: id => window.clearInterval(id) }) {
  let disposed = false, ending = false, checking = false;
  let expiryTimer: number | undefined;
  const schedule = (expiresAt: string) => {
    clock.clearTimeout(expiryTimer);
    const remaining = Date.parse(expiresAt) - clock.now();
    expiryTimer = clock.setTimeout(() => void check(), remaining > 0 ? Math.min(remaining, 2_147_000_000) : 60_000);
  };
  const check = async () => {
    if (disposed || ending || checking) return;
    checking = true;
    try {
      const refreshed = await hooks.validate(account.token);
      if (disposed || ending) return;
      hooks.updated(refreshed);
      hooks.unavailable("");
      schedule(refreshed.expiresAt);
    } catch (error) {
      if (disposed) return;
      if (!hooks.denied(error)) {
        hooks.unavailable("Бэкенд недоступен. Не удалось обновить подписку. Сессия сохранена, проверка повторится автоматически.");
        return;
      }
      ending = true;
      hooks.busy(true);
      try {
        await hooks.stop();
      } catch {
        ending = false;
        if (!disposed) hooks.unavailable("Доступ завершён. Не удалось остановить сценарии — повторяем остановку.");
        hooks.busy(false);
        return;
      }
      if (disposed) { hooks.busy(false); return; }
      await hooks.clear().catch(() => undefined);
      if (!disposed) hooks.ended(error);
      hooks.busy(false);
    } finally { checking = false; }
  };
  const timer = clock.setInterval(() => void check(), 60_000);
  schedule(account.expiresAt);
  return { check, dispose() { disposed = true; clock.clearInterval(timer); clock.clearTimeout(expiryTimer); } };
}
