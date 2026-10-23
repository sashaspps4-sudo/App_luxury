import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Activity, ArrowUpRight, Bot, Filter, MessageSquareReply, Search, Send, X } from "lucide-react";
import { GlassButton, Panel } from "../components/ui";
import { CustomSelect } from "../components/CustomSelect";
import { marketplaceGeos, marketplacePlatforms } from "../marketplaceData";

const platformOptions = [{ label: "Все площадки", value: "Все площадки" }, ...marketplacePlatforms.map((platform) => ({ label: platform, value: platform.toLowerCase() }))];
const normalizedGeo = (geo: string) => geo.toLowerCase() === "all" ? "Все гео" : geo;
const platformGeos = Object.fromEntries(Object.entries(marketplaceGeos).map(([platform, geos]) => [platform.toLowerCase(), geos.map(normalizedGeo)]));
const allGeoOptions = ["Все гео", ...Array.from(new Set(Object.values(platformGeos).flat().filter((geo) => geo !== "Все гео"))).sort((a, b) => a.localeCompare(b))];
const geosForPlatform = (selectedPlatform: string) => selectedPlatform === "Все площадки" ? allGeoOptions : ["Все гео", ...new Set(platformGeos[selectedPlatform] ?? [])];

const campaigns = [
  { name: "Vinted · винтажные часы", platform: "vinted", geo: "DE", kind: "Воронка", sent: 1284, replies: 386, auto: 312, autoSent: 246, started: "Сегодня, 14:32", status: "Активна" },
  { name: "Wallapop · коллекция сумок", platform: "wallapop", geo: "ES", kind: "Рассылка", sent: 842, replies: 204, auto: 176, autoSent: 138, started: "Сегодня, 12:08", status: "Завершена" },
  { name: "Depop · новые объявления", platform: "depop", geo: "GB", kind: "Воронка", sent: 619, replies: 173, auto: 141, autoSent: 104, started: "Сегодня, 10:45", status: "Активна" },
  { name: "Kleinanzeigen · аксессуары", platform: "kleinanzeigen", geo: "DE", kind: "Рассылка", sent: 403, replies: 91, auto: 77, autoSent: 66, started: "Вчера, 18:21", status: "Завершена" },
];

const trend = [28, 36, 31, 48, 42, 56, 49, 64, 58, 75, 68, 84, 78, 92];

const sentEvents = [
  { platform: "Vinted", geo: "DE", config: "Vinted_DE_03", accountNumber: "03", recipientEmail: "anna.meyer@example.com", message: "Hallo! Ist der Artikel noch verfügbar? Ich hätte Interesse.", time: "Сегодня, 14:32" },
  { platform: "Wallapop", geo: "ES", config: "Wallapop_ES_01", accountNumber: "01", recipientEmail: "lucia.ramos@example.com", message: "Hola, ¿sigue disponible? Me gustaría saber un poco más.", time: "Сегодня, 12:08" },
  { platform: "Depop", geo: "GB", config: "Depop_GB_02", accountNumber: "02", recipientEmail: "oliver.gray@example.com", message: "Hi! Is this still available? I can pay straight away.", time: "Сегодня, 10:45" },
];
const receivedAutoEvents = [
  { platform: "Vinted", geo: "DE", config: "Vinted_DE_03", account: "vinted.de · account-03", accountNumber: "03", message: "Thanks for your message. I’m away right now and will get back to you as soon as I can.", time: "Сегодня, 14:38" },
  { platform: "Wallapop", geo: "ES", config: "Wallapop_ES_01", account: "wallapop.es · account-01", accountNumber: "01", message: "Hola, gracias por tu mensaje. Ahora no estoy disponible, pero te responderé más tarde.", time: "Сегодня, 12:16" },
  { platform: "Depop", geo: "GB", config: "Depop_GB_02", account: "depop.uk · account-02", accountNumber: "02", message: "Thanks for reaching out. I’m currently away from the app and will reply when I’m back.", time: "Сегодня, 10:51" },
];
const sentAutoEvents = [
  { platform: "Vinted", geo: "DE", config: "Vinted_DE_03", account: "vinted.de · account-03", accountNumber: "03", message: "Автоответ: запрос получен. Проверю информацию и скоро вернусь с ответом.", count: 246, time: "Сегодня, 14:38" },
  { platform: "Wallapop", geo: "ES", config: "Wallapop_ES_01", account: "wallapop.es · account-01", accountNumber: "01", message: "Автоответ: спасибо за интерес. Отвечу на ваше сообщение при первой возможности.", count: 138, time: "Сегодня, 12:16" },
  { platform: "Depop", geo: "GB", config: "Depop_GB_02", account: "depop.uk · account-02", accountNumber: "02", message: "Автоответ: спасибо за сообщение. Скоро вернусь к вам с подробностями.", count: 104, time: "Сегодня, 10:51" },
];

type HistoryType = "sent" | "received" | "autoSent";
type HistoryItem = { platform: string; geo: string; config: string; account: string; accountLabel?: string; recipientEmail?: string; message?: string; time: string; count?: number };
const historyData: Record<HistoryType, HistoryItem[]> = {
  sent: sentEvents.map((item) => ({ ...item, account: item.accountNumber, accountLabel: "АККАУНТ №" })),
  received: receivedAutoEvents,
  autoSent: sentAutoEvents,
};

export function AnalyticsPage() {
  const [period, setPeriod] = useState("7 дней");
  const [platform, setPlatform] = useState("Все площадки");
  const [geo, setGeo] = useState("Все гео");
  const [kind, setKind] = useState("Все типы");
  const [historyType, setHistoryType] = useState<HistoryType | null>(null);
  const [historySearch, setHistorySearch] = useState("");
  const [historyPlatform, setHistoryPlatform] = useState("Все площадки");
  const [historyGeo, setHistoryGeo] = useState("Все гео");
  useEffect(() => {
    if (!historyType) return;
    const mainPanel = document.querySelector<HTMLElement>(".main-panel");
    if (!mainPanel) return;
    const previousOverflowY = mainPanel.style.overflowY;
    mainPanel.style.overflowY = "hidden";
    return () => { mainPanel.style.overflowY = previousOverflowY; };
  }, [historyType]);
  const visibleCampaigns = useMemo(() => campaigns.filter((item) =>
    (platform === "Все площадки" || item.platform === platform) &&
    (geo === "Все гео" || item.geo === geo) &&
    (kind === "Все типы" || item.kind === kind)
  ), [platform, geo, kind]);
  const sent = visibleCampaigns.reduce((sum, item) => sum + item.sent, 0);
  const replies = visibleCampaigns.reduce((sum, item) => sum + item.replies, 0);
  const receivedAutoReplies = visibleCampaigns.reduce((sum, item) => sum + item.auto, 0);
  const sentAutoReplies = visibleCampaigns.reduce((sum, item) => sum + item.autoSent, 0);
  const replyRate = sent ? Math.round((replies / sent) * 1000) / 10 : 0;
  const historyItems = (historyType ? historyData[historyType] : []).filter((item) =>
    (historyPlatform === "Все площадки" || item.platform.toLowerCase() === historyPlatform) &&
    (historyGeo === "Все гео" || item.geo === historyGeo) &&
    (!historySearch || `${item.platform} ${item.geo} ${item.config} ${item.account} ${item.recipientEmail ?? ""} ${item.message ?? ""}`.toLowerCase().includes(historySearch.toLowerCase()))
  );
  const historyTitle = historyType === "sent" ? "Отправленные письма" : historyType === "autoSent" ? "Отправленные автоответы" : "Полученные ответы";
  const historyDescription = historyType === "sent" ? "История писем с площадкой, конфигурацией и аккаунтом" : historyType === "autoSent" ? "История автоответов, отправленных системой" : "Полный список автоматических сообщений с площадок";
  const filteredGeoOptions = geosForPlatform(platform);
  const historyGeoOptions = geosForPlatform(historyPlatform);

  return <>
    <section className="page-heading analytics-heading">
      <div><p className="kicker">ОТПРАВКИ / ОТВЕТЫ / ВОРОНКИ</p><h1>Аналитика <span>рассылок</span></h1><p>Смотрите, сколько сообщений отправлено и какие ответы они принесли.</p></div>
    </section>

    <div className="analytics-filters panel-surface">
      <CustomSelect label="ПЛОЩАДКА" value={platform} options={platformOptions} onChange={(value) => { setPlatform(value); setGeo("Все гео"); }} />
      <CustomSelect label="ГЕО" value={geo} options={filteredGeoOptions} onChange={setGeo} />
      <div className="analytics-kind" aria-label="Тип активности">{["Все типы", "Рассылка", "Воронка"].map((option) => <button className={kind === option ? "active" : ""} key={option} onClick={() => setKind(option)}>{option}</button>)}</div>
      <span className="filter-note"><Filter size={13} /> Фильтр по списку и сводке</span>
    </div>

    <section className="analytics-stats">
      <article className="analytics-stat"><div><span>ОТПРАВЛЕНО</span><Send size={15} /></div><strong>{sent.toLocaleString("ru-RU")}</strong><small><i className="stat-trend"><ArrowUpRight size={12} /> 12%</i> к прошлой неделе</small></article>
      <article className="analytics-stat"><div><span>ПОЛУЧЕНО ОТВЕТОВ</span><MessageSquareReply size={15} /></div><strong>{replies.toLocaleString("ru-RU")}</strong><small>Ответили на ваши сообщения</small></article>
      <article className="analytics-stat"><div><span>ОТПРАВЛЕНО АВТООТВЕТОВ</span><Bot size={15} /></div><strong>{receivedAutoReplies.toLocaleString("ru-RU")}</strong><small>Отправленные автоматические ответы</small></article>
      <article className="analytics-stat"><div><span>ДОЛЯ ОТВЕТОВ</span><Activity size={15} /></div><strong>{replyRate}<em>%</em></strong><small>Ответы от числа отправок</small></article>
    </section>

    <section className="event-panels">
      <Panel className="event-panel">
        <div className="event-panel-head"><div className="event-icon sent-icon"><Send size={15} /></div><div><h2>Отправленные письма</h2><p>Журнал отправок по аккаунтам</p></div></div>
        <div className="event-column-labels"><span>АККАУНТ / ПЛОЩАДКА / КОНФИГ / ПОЛУЧАТЕЛЬ</span><span>ВРЕМЯ</span></div>
        {sentEvents.filter((item) => (platform === "Все площадки" || item.platform.toLowerCase() === platform) && (geo === "Все гео" || item.geo === geo)).map((item) => <div className="event-entry" key={`${item.config}-${item.accountNumber}-${item.time}`}><div className="event-entry-main"><strong>{item.platform} <i>·</i> {item.geo}</strong><small>Аккаунт № {item.accountNumber} <i>·</i> Конфиг: {item.config}</small><small className="event-message">{item.message}</small></div><span className="event-time">{item.time}</span></div>)}
        {sentEvents.filter((item) => (platform === "Все площадки" || item.platform.toLowerCase() === platform) && (geo === "Все гео" || item.geo === geo)).length === 0 && <div className="analytics-empty">Нет отправок по выбранным фильтрам</div>}
        <button className="event-panel-more" onClick={() => setHistoryType("sent")}>Все отправленные письма <ArrowUpRight size={13} /></button>
      </Panel>
      <Panel className="event-panel">
        <div className="event-panel-head"><div className="event-icon incoming-icon"><MessageSquareReply size={15} /></div><div><h2>Полученные ответы</h2><p>Ответы продавцов</p></div><strong>{receivedAutoReplies.toLocaleString("ru-RU")}</strong></div>
        <div className="event-column-labels"><span>ПЛОЩАДКА / КОНФИГ / СООБЩЕНИЕ</span><span>ВРЕМЯ</span></div>
        {receivedAutoEvents.filter((item) => (platform === "Все площадки" || item.platform.toLowerCase() === platform) && (geo === "Все гео" || item.geo === geo)).map((item) => <div className="event-entry" key={item.config}><div className="event-entry-main"><strong>{item.platform} <i>·</i> {item.geo}</strong><small>Аккаунт № {item.accountNumber} <i>·</i> Конфиг: {item.config}</small><small className="event-message">{item.message}</small></div><span className="event-time">{item.time}</span></div>)}
        {receivedAutoEvents.filter((item) => (platform === "Все площадки" || item.platform.toLowerCase() === platform) && (geo === "Все гео" || item.geo === geo)).length === 0 && <div className="analytics-empty">Нет автоответов по выбранным фильтрам</div>}
        <button className="event-panel-more" onClick={() => setHistoryType("received")}>Все полученные автоответы <ArrowUpRight size={13} /></button>
      </Panel>
      <Panel className="event-panel">
        <div className="event-panel-head"><div className="event-icon outgoing-icon"><Bot size={15} /></div><div><h2>Отправленные автоответы</h2><p>Ответы, отправленные автоматически</p></div><strong>{sentAutoReplies.toLocaleString("ru-RU")}</strong></div>
        <div className="event-column-labels"><span>ПЛОЩАДКА / КОНФИГ / ШАБЛОН</span><span>ВРЕМЯ</span></div>
        {sentAutoEvents.filter((item) => (platform === "Все площадки" || item.platform.toLowerCase() === platform) && (geo === "Все гео" || item.geo === geo)).map((item) => <div className="event-entry" key={item.config}><div className="event-entry-main"><strong>{item.platform} <i>·</i> {item.geo}</strong><small>Аккаунт № {item.accountNumber} <i>·</i> Конфиг: {item.config}</small><small className="event-message">{item.message}</small></div><span className="event-time">{item.time}</span></div>)}
        {sentAutoEvents.filter((item) => (platform === "Все площадки" || item.platform.toLowerCase() === platform) && (geo === "Все гео" || item.geo === geo)).length === 0 && <div className="analytics-empty">Нет отправленных автоответов по выбранным фильтрам</div>}
        <button className="event-panel-more" onClick={() => setHistoryType("autoSent")}>Все отправленные автоответы <ArrowUpRight size={13} /></button>
      </Panel>
    </section>
    <div className="analytics-footnote"><span><Bot size={13} /> Полученные автоответы входят в общее число полученных ответов</span></div>
    <Panel className="analytics-chart-panel">
      <div className="panel-toolbar"><div><div className="title-row"><span className="title-mark" /><h2>Динамика автоответов</h2></div><p>Полученные и отправленные автоответы по дням</p></div><div className="period-tabs glass-surface">{["7 дней", "30 дней", "90 дней"].map((item) => <button className={period === item ? "active" : ""} onClick={() => setPeriod(item)} key={item}>{item}</button>)}</div></div>
      <div className="analytics-chart"><div className="analytics-y-axis"><span>1 000</span><span>750</span><span>500</span><span>250</span><span>0</span></div><div className="analytics-plot"><div className="analytics-grid">{[0, 1, 2, 3, 4].map((item) => <i key={item} />)}</div><svg viewBox="0 0 700 180" preserveAspectRatio="none" aria-label="Динамика полученных и отправленных автоответов"><defs><linearGradient id="sent-area" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#b6a4f5" stopOpacity=".2"/><stop offset="1" stopColor="#b6a4f5" stopOpacity="0"/></linearGradient></defs><polygon points={`0,180 ${trend.map((v, i) => `${i * 53},${180 - v * 1.65}`).join(" ")} 700,180`} fill="url(#sent-area)"/><polyline points={trend.map((v, i) => `${i * 53},${180 - v * 1.65}`).join(" ")} className="analytics-line sent"/><polyline points={trend.map((v, i) => `${i * 53},${180 - v * .83}`).join(" ")} className="analytics-line reply"/></svg><div className="analytics-x-axis">{["12 окт", "13 окт", "14 окт", "15 окт", "16 окт", "17 окт", "18 окт"].map((day) => <span key={day}>{day}</span>)}</div></div></div>
      <div className="analytics-chart-legend"><span><i className="sent-dot" /> Получено автоответов</span><span><i className="reply-dot" /> Отправлено автоответов</span></div>
    </Panel>
    {historyType && createPortal(<div className="history-modal-backdrop" onMouseDown={() => setHistoryType(null)}>
      <section className="history-modal panel-surface" role="dialog" aria-modal="true" aria-labelledby="received-history-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="history-modal-header"><div><p className="kicker">ИСТОРИЯ СОБЫТИЙ</p><h2 id="received-history-title">{historyTitle}</h2><p>{historyDescription}</p></div><button type="button" className="glass-icon" aria-label="Закрыть окно" onClick={() => setHistoryType(null)}><X size={17} /></button></header>
        <div className="history-modal-toolbar"><label className="history-search"><Search size={16} /><input autoFocus value={historySearch} onChange={(event) => setHistorySearch(event.target.value)} placeholder="Поиск по тексту, конфигу или аккаунту" /></label><CustomSelect label="ПЛОЩАДКА" value={historyPlatform} options={platformOptions} onChange={(value) => { setHistoryPlatform(value); setHistoryGeo("Все гео"); }} /><CustomSelect label="ГЕО" value={historyGeo} options={historyGeoOptions} onChange={setHistoryGeo} /></div>
        <div className="history-modal-summary"><span>{historyItems.length} записей</span></div>
        <div className="history-event-list">{historyItems.map((item, index) => <article className="history-event" key={`${item.config}-${item.time}`}><div className="history-event-meta"><span className="history-event-index">{String(index + 1).padStart(2, "0")}</span><strong>{item.platform} <i>·</i> {item.geo}</strong><time>{item.time}</time></div><div className="history-event-details"><span><small>КОНФИГ</small>{item.config}</span><span><small>{item.accountLabel ?? "АККАУНТ"}</small>{item.account}</span>{item.recipientEmail && <span><small>ПОЧТА ПОЛУЧАТЕЛЯ</small>{item.recipientEmail}</span>}{item.count !== undefined && <span><small>КОЛИЧЕСТВО</small>{item.count.toLocaleString("ru-RU")}</span>}</div>{item.message && <p>{item.message}</p>}</article>)}{historyItems.length === 0 && <div className="history-empty">По вашему запросу ничего не найдено</div>}</div>
        <footer className="history-modal-footer"><GlassButton onClick={() => setHistoryType(null)}>ЗАКРЫТЬ</GlassButton></footer>
      </section>
    </div>, document.body)}
  </>;
}
