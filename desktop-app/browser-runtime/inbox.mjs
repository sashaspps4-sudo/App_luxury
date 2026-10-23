// Metadata only: never open a message or mark it read while taking a baseline.
export function readInboxDocument() {
  const visible = element => !!element && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
  const account = document.querySelector('a[href*="SignOutOptions"]');
  const accountLabel = account?.getAttribute('aria-label') ?? '';
  const emailPattern = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig;
  const identity = (accountLabel.match(emailPattern) ?? document.title.match(emailPattern) ?? []).at(-1)?.toLowerCase();
  const rows = [...document.querySelectorAll('tr.zA')].filter(visible);
  const entries = [];
  const isGoogle = email => {
    const domain = email.toLowerCase().split('@').at(-1).replace(/\.$/, '');
    return domain === 'google.com' || domain.endsWith('.google.com');
  };
  let ignored = 0;
  for (const row of rows) {
    const senders = [...new Set([...row.querySelectorAll('.yW [email]')].map(node => node.getAttribute('email')?.trim().toLowerCase()).filter(Boolean))];
    if (!senders.length) throw new Error('Не удалось определить отправителя во входящих.');
    if (senders.every(isGoogle)) { ignored++; continue; }
    const identifier = row.querySelector('[data-legacy-thread-id], [data-thread-id]');
    const threadId = identifier?.getAttribute('data-legacy-thread-id') || identifier?.getAttribute('data-thread-id');
    const messageId = identifier?.getAttribute('data-legacy-last-non-draft-message-id') || identifier?.getAttribute('data-legacy-last-message-id');
    if (!threadId || !messageId) throw new Error('Gmail не предоставил устойчивые идентификаторы входящих.');
    entries.push({ thread_id: threadId, message_id: messageId, sender_emails: senders.filter(email => !isGoogle(email)) });
  }
  // Gmail's paging controls use these locale-independent icons.
  const next = [...document.querySelectorAll('[role="button"]')].find(button => visible(button) && button.querySelector('.amJ'));
  const hasNext = !!next && next.getAttribute('aria-disabled') !== 'true' && !next.classList.contains('T-I-JE');
  const loaded = rows.length > 0 || [...document.querySelectorAll('.TC')].some(visible);
  const counters = [...document.querySelectorAll('.Dj')].filter(visible).flatMap(node => [...node.querySelectorAll('.ts')].map(span => Number(span.textContent.replace(/\D/g, ''))));
  if (counters.length >= 3 && counters[2] > counters[1] && !hasNext) throw new Error('Не найдена кнопка следующей страницы входящих.');
  const signature = rows.map(row => {
    const id = row.querySelector('[data-legacy-thread-id], [data-thread-id]');
    return `${id?.getAttribute('data-legacy-thread-id') || id?.getAttribute('data-thread-id')}:${id?.getAttribute('data-legacy-last-message-id')}`;
  }).join('|');
  return { mailbox_email: identity, entries, ignored, hasNext, loaded, signature };
}

export async function captureInbox(page) {
  const url = new URL(page.url());
  if (url.protocol !== 'https:' || url.hostname !== 'mail.google.com' || url.port || url.username || url.password || !/^\/mail\/u\/\d+\//.test(url.pathname)) throw new Error('Открытая вкладка не является почтой Gmail.');
  const root = `https://mail.google.com${url.pathname.match(/^\/mail\/u\/\d+\//)[0]}`;
  let movedToInbox = false;
  if (url.hash !== '#inbox') {
    await page.goto(root + '#inbox', { waitUntil: 'domcontentloaded', timeout: 30000 });
    movedToInbox = true;
  }
  // Searching in:inbox includes Primary, Promotions, Social and other inbox tabs.
  const search = root + '#search/in%3Ainbox';
  const entries = new Map();
  let ignored = 0;
  let pages = 0;
  let mailbox;
  const scannedAt = new Date().toISOString();
  const signatures = new Set();
  try {
    await page.goto(search, { waitUntil: 'domcontentloaded', timeout: 30000 });
    while (true) {
      const deadline = Date.now() + 25000;
      let state;
      let stable = '';
      let settledAt = Date.now();
      let settled = false;
      while (Date.now() < deadline) {
        state = await page.evaluate(readInboxDocument);
        if (state.loaded && state.mailbox_email) {
          if (state.signature !== stable) { stable = state.signature; settledAt = Date.now(); }
          if (Date.now() - settledAt >= 500) { settled = true; break; }
        }
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      if (!settled || !state?.loaded || !state.mailbox_email) throw Object.assign(new Error('Не удалось дождаться списка входящих или определить почтовый аккаунт.'), { code: 'inbox_not_ready' });
      if (new URL(page.url()).hash.indexOf('#search/') !== 0) throw new Error('Вкладка Gmail изменилась во время синхронизации.');
      if (mailbox && mailbox !== state.mailbox_email) throw new Error('Почтовый аккаунт изменился во время синхронизации.');
      mailbox = state.mailbox_email;
      if (signatures.has(state.signature)) throw new Error('Gmail повторил страницу входящих. Синхронизация остановлена.');
      signatures.add(state.signature);
      pages++;
      ignored += state.ignored;
      for (const entry of state.entries) entries.set(`${entry.thread_id}:${entry.message_id}`, entry);
      if (entries.size > 20000 || pages > 400) throw new Error('Входящих слишком много для одного отпечатка (максимум 20 000 цепочек).');
      if (!state.hasNext) break;
      const before = state.signature;
      await page.locator('[role="button"]').filter({ has: page.locator('.amJ') }).filter({ visible: true }).first().click({ timeout: 10000 });
      const changeDeadline = Date.now() + 25000;
      while (Date.now() < changeDeadline) {
        const next = await page.evaluate(readInboxDocument);
        if (next.loaded && next.signature !== before) break;
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    }
    return { mailbox_email: mailbox, entries: [...entries.values()], ignored_count: ignored, pages, scanned_at: scannedAt, moved_to_inbox: movedToInbox };
  } finally {
    if (!page.isClosed()) await page.goto(root + '#inbox', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  }
}


export async function captureInboxWithRecovery(page, { mailbox, capture = captureInbox, isStopped = () => false, emit = () => {}, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const stopped = () => { if (isStopped() || page.isClosed()) throw new Error('Проверка входящих остановлена: браузер закрыт или получена команда остановки.'); };
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    stopped();
    const url = new URL(page.url());
    if (url.origin !== 'https://mail.google.com' || !/^\/mail\/u\/\d+\//.test(url.pathname)) throw new Error('Вкладка Gmail изменилась. Проверка остановлена.');
    try {
      if (attempt) await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
      const snapshot = await capture(page);
      stopped();
      if (mailbox && snapshot.mailbox_email !== mailbox) throw new Error('Почтовый аккаунт изменился при проверке входящих.');
      return snapshot;
    } catch (error) {
      stopped();
      const transient = error.code === 'inbox_not_ready' || error.name === 'TimeoutError' || /Execution context was destroyed|net::ERR_(CONNECTION|TIMED_OUT|NETWORK|PROXY|TUNNEL)/.test(error.message ?? '');
      if (!transient) throw error;
      lastError = error;
      if (attempt === 2) break;
      emit('info', `Входящие временно недоступны: ${error.message} Повтор ${attempt + 1} из 2 с обновлением Gmail.`);
      for (let remaining = attempt === 0 ? 2000 : 5000; remaining > 0; remaining -= 100) { stopped(); await sleep(Math.min(100, remaining)); }
    }
  }
  throw Object.assign(new Error(`Проверка входящих не удалась после 3 попыток: ${lastError.message}`), { retryableInbox: true });
}
