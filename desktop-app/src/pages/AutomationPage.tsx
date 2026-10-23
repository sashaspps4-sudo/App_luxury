import { useEffect, useRef, useState } from "react";
import { Clock3, MailCheck, Settings2 } from "lucide-react";
import { Panel } from "../components/ui";
import { CustomSelect } from "../components/CustomSelect";
import { automationError, automationLimits, defaultAutomation, loadAutomation, saveAutomation, type AutomationSettings } from "../automationSettings";

export function AutomationPage() {
  const [value, setValue] = useState(defaultAutomation);
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState("Загрузка настроек…");
  const revision = useRef(0);
  useEffect(() => {
    let disposed = false;
    void loadAutomation().then(settings => { if (!disposed) { setValue(settings); setReady(true); setNotice("Все изменения сохраняются автоматически"); } }).catch(error => { if (!disposed) setNotice(String(error)); });
    return () => { disposed = true; };
  }, []);
  function update(next: AutomationSettings) {
    setValue(next);
    const current = ++revision.current;
    const error = automationError(next);
    if (error) { setNotice(error); return; }
    setNotice("Сохранение…");
    void saveAutomation(next).then(() => { if (current === revision.current) setNotice("Изменения сохранены"); }).catch(error => { if (current === revision.current) setNotice(`Не удалось сохранить: ${String(error)}`); });
  }
  const field = (key: keyof typeof automationLimits, label: string, hint: string, unit: string, disabled = false) => (
    <label className={`automation-field${disabled ? " is-disabled" : ""}`} key={key}>
      <span>{label}</span><small>{hint}</small>
      <div className="automation-input"><input disabled={disabled} type="number" min={0} max={automationLimits[key]} step={1} value={Number.isNaN(value[key]) ? "" : value[key]} onChange={event => update({ ...value, [key]: event.target.value === "" ? NaN : Number(event.target.value) })} /><span>{unit}</span></div>
    </label>
  );
  return <div className="automation-page">
    <div className="page-heading"><div><p className="kicker">WORKSPACE</p><h1>Автоматизация</h1><p>Единые настройки для всех профилей и конфигураций рассылки</p></div></div>
    <p className="automation-save-state" role="status">{notice}</p>
    <fieldset className="automation-controls" disabled={!ready}>
      <div className="automation-grid">
        <Panel className="automation-card">
          <div className="settings-card-heading"><span className="settings-heading-icon"><Clock3 size={18} /></span><div><h2>Темп отправки</h2><p>Паузы и ограничения для каждого профиля</p></div></div>
          <div className="automation-fields">
            {field("maxPerProfile", "Лимит писем на профиль за запуск", "Общий лимит на все циклы; 0 — до исчерпания объявлений", "писем")}
            {field("pauseEverySent", "Пауза после серии писем", "После скольких отправок делать перерыв; 0 — отключить", "писем")}
            {field("delayMinSeconds", "Задержка между письмами: от", "Минимальная пауза перед следующим письмом", "сек.")}
            {field("delayMaxSeconds", "Задержка между письмами: до", "Максимальная пауза; время выбирается в этом диапазоне", "сек.")}
            {field("pauseSeconds", "Время паузы после писем", "Продолжительность перерыва после серии", "сек.")}
          </div>
        </Panel>
        <Panel className="automation-card">
          <div className="settings-card-heading"><span className="settings-heading-icon"><MailCheck size={18} /></span><div><h2>Проверка входящих</h2><p>Во время отправки и после достижения лимита</p></div></div>
          <div className="automation-fields">
            {field("checkEverySent", "Проверять входящие каждые N отправок", "Размер цикла на профиль; после цикла — проверка. 0 — без проверок, партии по 10", "писем")}
            {field("checkEverySeconds", "Проверять входящие каждые N секунд", value.afterQueue === "finish" ? "Недоступно: выбрано «Завершить работу». Выберите продолжение проверок после очереди." : "Включается после достижения лимита отправок или завершения очереди", "сек.", value.afterQueue === "finish")}
            <div className="automation-field automation-wide"><span>После завершения очереди</span><small>Действие после отправки всех писем или достижения лимита</small><CustomSelect ariaLabel="После завершения очереди" className="automation-select" disabled={!ready} value={value.afterQueue} onChange={afterQueue => update({ ...value, afterQueue: afterQueue as AutomationSettings["afterQueue"] })} options={[{ value: "finish", label: "Завершить работу" }, { value: "monitor", label: "Продолжить проверять входящие" }]} /></div>
          </div>
          <div className="automation-note"><Settings2 size={16} /><span>Настройки применяются при запуске рассылки. Каждый профиль работает независимо. Проверка входящих сохраняет найденные ответы для дальнейшей обработки.</span></div>
        </Panel>
      </div>
    </fieldset>
  </div>;
}
