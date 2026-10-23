export type SessionRun = {
  runId: string;
  startedAtMs?: number;
  endedAtMs?: number | null;
  campaignStarted?: boolean;
  stopRequested?: boolean;
  parserComplete?: boolean;
};
export type SessionProfile = { status: string; campaignPhase?: string };

export function sessionState(run: SessionRun | null, profiles: SessionProfile[], operation: string | null = null) {
  if (!run) return operation ?? "Ожидает запуска";
  const open = profiles.filter(profile => !["closed", "error"].includes(profile.status));
  const failed = profiles.some(profile => profile.status === "error" || profile.campaignPhase === "halted");
  if (run.endedAtMs != null || profiles.length > 0 && !open.length) {
    if (failed) return "Завершена с ошибками";
    if (run.stopRequested) return "Сессия остановлена";
    return run.campaignStarted ? "Рассылка завершена" : "Сессия закрыта";
  }
  if (run.stopRequested) return "Останавливаем сессию";
  if (operation) return operation;
  if (open.some(profile => profile.campaignPhase === "running")) return "Рассылка выполняется";
  if (open.some(profile => profile.campaignPhase === "monitoring")) return "Мониторинг входящих";
  if (run.campaignStarted) return failed ? "Отправка остановлена с ошибкой" : "Завершаем рассылку";
  if (open.some(profile => profile.status === "starting")) return "Открываем браузеры";
  if (open.some(profile => profile.status === "checking")) return "Проверяем аккаунты";
  if (open.length && open.every(profile => profile.status === "ready")) return "Аккаунты готовы";
  return "Ожидаем входа в Gmail";
}

export function sessionElapsed(run: SessionRun | null, now = Date.now()) {
  const start = run?.startedAtMs;
  if (typeof start !== "number" || !Number.isFinite(start)) return "00:00:00";
  const end = run?.endedAtMs ?? now;
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(value => String(value).padStart(2, "0")).join(":");
}
