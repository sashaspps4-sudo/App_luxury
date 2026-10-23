import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { captureInbox, captureInboxWithRecovery } from './inbox.mjs';

export const defaults = JSON.parse(readFileSync(new URL('./automation-defaults.json', import.meta.url), 'utf8'));
export function normalizeAutomation(value = {}) {
  const result = { ...defaults, ...value };
  if (value.checkEverySeconds === undefined && value.checkEveryMinutes !== undefined) result.checkEverySeconds = value.checkEveryMinutes * 60;
  delete result.checkEveryMinutes;
  for (const [key, max] of Object.entries({ delayMinSeconds: 86400, delayMaxSeconds: 86400, checkEverySent: 10000, checkEverySeconds: 86400, maxPerProfile: 100000, pauseEverySent: 10000, pauseSeconds: 86400 })) {
    if (!Number.isInteger(result[key]) || result[key] < 0 || result[key] > max) throw new Error('Некорректные настройки автоматизации.');
  }
  if (result.delayMinSeconds > result.delayMaxSeconds || (result.pauseEverySent && !result.pauseSeconds) || !['finish', 'monitor'].includes(result.afterQueue) || (result.afterQueue === 'monitor' && !result.checkEverySeconds)) throw new Error('Проверьте диапазон задержки, время перерыва и интервал проверки входящих.');
  return result;
}

export async function checkCampaignInbox(context, { profileId, mailbox, api, capture = captureInbox, isStopped = () => false, emit = () => {} }) {
  const page = context.pages().find(page => !page.isClosed() && /^https:\/\/mail\.google\.com\/mail\/u\/\d+\//.test(page.url()));
  if (!page) throw new Error('Вкладка Gmail закрыта.');
  const snapshot = await captureInboxWithRecovery(page, { mailbox, capture, isStopped, emit });
  if (snapshot.mailbox_email !== mailbox) throw new Error('Почтовый аккаунт изменился при проверке входящих.');
  const { entries, moved_to_inbox: _moved, ...metadata } = snapshot;
  const run_id = `auto-${randomUUID()}`;
  const upload_id = createHash('sha256').update(JSON.stringify({ run_id, ...snapshot })).digest('hex');
  const chunks = [];
  let chunk = [];
  for (const entry of entries) {
    if (Buffer.byteLength(JSON.stringify(entry)) > 8000) throw new Error('Метаданные цепочки Gmail слишком большие.');
    if (chunk.length && (chunk.length >= 40 || Buffer.byteLength(JSON.stringify([...chunk, entry])) > 10000)) { chunks.push(chunk); chunk = []; }
    chunk.push(entry);
  }
  chunks.push(chunk);
  for (let part_index = 0; part_index < chunks.length; part_index++) {
    const receipt = await api('/v1/inbox/baseline', { ...metadata, run_id, profile_id: profileId, upload_id, part_index, total_parts: chunks.length, expected_count: entries.length, entries: chunks[part_index] });
    if (receipt.complete) return receipt;
  }
  throw new Error('Сервер не подтвердил сохранение входящих.');
}

export function createAutomation(settings, { checkInbox, isStopped, emit, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), random = Math.random }) {
  const config = normalizeAutomation(settings);
  let lastCheck = now(), sinceCheck = 0, lastSent = null, series = 0;
  let monitoring = false;
  const interval = config.checkEverySeconds * 1000;
  const stopped = () => { if (isStopped()) throw new Error('automation_stopped'); };
  const check = async () => {
    stopped();
    emit('info', 'Автоматизация: проверяем входящие.', monitoring ? { phase: 'monitoring' } : {});
    let receipt;
    try { receipt = await checkInbox(); }
    catch (error) {
      stopped();
      if (!error.retryableInbox) throw error;
      lastCheck = now(); sinceCheck = 0;
      emit('error', `${error.message} Пропускаем эту проверку; следующая — по расписанию.`, monitoring ? { phase: 'monitoring' } : {});
      return;
    }
    lastCheck = now(); sinceCheck = 0;
    emit('info', `Проверка входящих завершена: новых ${receipt.added ?? 0}; найдено для обработки ${receipt.matched ?? 0}.`, monitoring ? { phase: 'monitoring' } : {});
  };
  const due = () => config.checkEverySent > 0 && sinceCheck >= config.checkEverySent;
  const waitUntil = async deadline => {
    while (now() < deadline) {
      stopped();
      await sleep(Math.max(1, Math.min(250, deadline - now())));
    }
    stopped();
  };
  return {
    config,
    noteSent() { lastSent = now(); sinceCheck++; series++; },
    async beforeSend() {
      stopped();
      if (due()) await check();
      if (lastSent !== null) {
        let seconds = config.delayMinSeconds + Math.floor(random() * (config.delayMaxSeconds - config.delayMinSeconds + 1));
        if (config.pauseEverySent > 0 && series >= config.pauseEverySent) {
          seconds = Math.max(seconds, config.pauseSeconds); series = 0;
          emit('info', `Автоматизация: перерыв после серии писем — ${seconds} сек.`);
        } else if (seconds > 0) emit('info', `Автоматизация: пауза между письмами — ${seconds} сек.`);
        await waitUntil(lastSent + seconds * 1000);
      }
      if (due()) await check();
    },
    async finish() {
      if (due()) await check();
      if (config.afterQueue !== 'monitor') return;
      monitoring = true;
      lastCheck = now();
      emit('info', `Отправка завершена. Продолжаем проверять входящие каждые ${config.checkEverySeconds} сек.`, { phase: 'monitoring' });
      while (!isStopped()) { await waitUntil(lastCheck + interval); await check(); }
      stopped();
    },
  };
}
