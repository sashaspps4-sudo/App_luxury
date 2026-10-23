import { invoke, isTauri } from "@tauri-apps/api/core";
import defaults from "../browser-runtime/automation-defaults.json";
export type AutomationSettings = Omit<typeof defaults, "afterQueue"> & { afterQueue: "finish" | "monitor" };
export const defaultAutomation = (): AutomationSettings => ({ ...defaults, afterQueue: "finish" });
export const automationLimits = { delayMinSeconds: 86400, delayMaxSeconds: 86400, checkEverySent: 10000, checkEverySeconds: 86400, maxPerProfile: 100000, pauseEverySent: 10000, pauseSeconds: 86400 };
export function automationError(value: AutomationSettings): string {
  for (const [key, max] of Object.entries(automationLimits)) {
    const number = value[key as keyof typeof automationLimits];
    if (!Number.isInteger(number) || number < 0 || number > max) return "Введите целые неотрицательные значения в допустимых пределах.";
  }
  if (value.delayMinSeconds > value.delayMaxSeconds) return "Минимальная задержка не должна превышать максимальную.";
  if (value.pauseEverySent > 0 && value.pauseSeconds === 0) return "Укажите время паузы после серии писем.";
  if (!["finish", "monitor"].includes(value.afterQueue)) return "Выберите действие после завершения очереди.";
  if (value.afterQueue === "monitor" && value.checkEverySeconds === 0) return "Для проверки после завершения очереди задайте интервал в секундах.";
  return "";
}
const key = "luxury-mailer.automation.v1";
let queue = Promise.resolve();
export async function loadAutomation(): Promise<AutomationSettings> {
  await queue.catch(() => {});
  const text = isTauri() ? await invoke<string | null>("load_automation") : localStorage.getItem(key);
  const raw = text ? JSON.parse(text) : {};
  if (raw.checkEverySeconds === undefined && raw.checkEveryMinutes !== undefined) raw.checkEverySeconds = raw.checkEveryMinutes * 60;
  delete raw.checkEveryMinutes;
  const value = { ...defaultAutomation(), ...raw } as AutomationSettings;
  const error = automationError(value);
  if (error) throw new Error(error);
  return value;
}
export function saveAutomation(value: AutomationSettings): Promise<void> {
  const error = automationError(value);
  if (error) return Promise.reject(new Error(error));
  const contents = JSON.stringify(value);
  const saved = queue.catch(() => {}).then(async () => {
    if (isTauri()) await invoke("save_automation", { contents });
    else localStorage.setItem(key, contents);
  });
  queue = saved;
  return saved;
}
export function flushAutomation(): Promise<void> { return queue; }
