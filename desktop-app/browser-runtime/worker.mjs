import { chromium } from 'playwright';
import { anonymizeProxy, closeAnonymizedProxy } from 'proxy-chain';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureInbox } from './inbox.mjs';
import { runCampaign } from './sender.mjs';
import { runCampaignCycles } from './campaign-cycles.mjs';

export function parseProxy(value) {
  const raw = value.trim();
  if (!raw) return null;
  const parts = raw.split(':');
  const normalized = !raw.includes('://') && !raw.includes('@') && parts.length === 4
    ? `socks5://${encodeURIComponent(parts[2])}:${encodeURIComponent(parts[3])}@${parts[0]}:${parts[1]}`
    : raw.includes('://') ? raw : `socks5://${raw}`;
  let url;
  try { url = new URL(normalized); } catch { throw new Error('Укажите SOCKS5-прокси: socks5://login:password@host:port'); }
  if (url.protocol !== 'socks5:' || !url.hostname || !url.port || Number(url.port) > 65535 || url.pathname || url.search || url.hash)
    throw new Error('Некорректный SOCKS5-прокси. Проверьте адрес и порт.');
  return url.href;
}

export function isGmailMailbox(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'mail.google.com' && !url.port
      && !url.username && !url.password && /^\/mail\/u\/\d+\//.test(url.pathname);
  } catch { return false; }
}

// Map an ISO-3166 country code to a representative IANA timezone and locale so
// the browser's clock and language match the proxy geo instead of the host.
const GEO_TIMEZONE = {
  AU: 'Australia/Sydney', US: 'America/Chicago', CA: 'America/Toronto', GB: 'Europe/London',
  DE: 'Europe/Berlin', FR: 'Europe/Paris', ES: 'Europe/Madrid', IT: 'Europe/Rome',
  NL: 'Europe/Amsterdam', BE: 'Europe/Brussels', PL: 'Europe/Warsaw', CH: 'Europe/Zurich',
  AT: 'Europe/Vienna', PT: 'Europe/Lisbon', SE: 'Europe/Stockholm', NO: 'Europe/Oslo',
  BR: 'America/Sao_Paulo', IN: 'Asia/Kolkata', JP: 'Asia/Tokyo', CN: 'Asia/Shanghai',
  KR: 'Asia/Seoul', AE: 'Asia/Dubai', SG: 'Asia/Singapore', MY: 'Asia/Kuala_Lumpur',
  CZ: 'Europe/Prague', DK: 'Europe/Copenhagen', GR: 'Europe/Athens', LT: 'Europe/Vilnius', RO: 'Europe/Bucharest',
};
const GEO_LOCALE = { AU: 'en-AU', US: 'en-US', CA: 'en-CA', GB: 'en-GB', DE: 'de-DE', FR: 'fr-FR', ES: 'es-ES', IT: 'it-IT', NL: 'nl-NL', BE: 'nl-BE', PL: 'pl-PL', CH: 'de-CH', AT: 'de-AT', PT: 'pt-PT', SE: 'sv-SE', NO: 'no-NO', BR: 'pt-BR', IN: 'en-IN', JP: 'ja-JP', CN: 'zh-CN', KR: 'ko-KR', AE: 'en-AE', SG: 'en-SG', MY: 'en-MY' };

export function geoFingerprint(geos) {
  const raw = Array.isArray(geos) ? String(geos[0] ?? '').toUpperCase().trim() : '';
  const geo = ({ UK: 'GB', USA: 'US' })[raw] ?? raw;
  if (!/^[A-Z]{2}$/.test(geo) || !(geo in GEO_TIMEZONE)) return null;
  return { timezoneId: GEO_TIMEZONE[geo], locale: GEO_LOCALE[geo] ?? `en-${geo}` };
}

// Mask the automation signals Gmail probes for (navigator.webdriver, the missing
// window.chrome.runtime object, the generic ANGLE WebGL renderer token) on every
// page of the context, including pages created after launch.
async function applyFingerprint(context) {
  const fingerprint = () => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    // Playwright's Chromium ships window.chrome but without the runtime object that
    // real Chrome exposes; add it in place rather than replacing the whole object.
    if (window.chrome && window.chrome.runtime === undefined) window.chrome.runtime = {};
    if (window.WebGLRenderingContext) {
      const getParameter = window.WebGLRenderingContext.prototype.getParameter;
      window.WebGLRenderingContext.prototype.getParameter = function (id) {
        if (id === 37445) return 'Google Inc.';
        if (id === 37446) return 'ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)';
        return getParameter.call(this, id);
      };
    }
  };
  // Register once on the context so it fires on every navigation and on any tab
  // Gmail opens later; then patch the already-loaded pages so the first probe sees it.
  // Each call is wrapped in Promise.resolve so a synchronously-thrown method
  // (present on partial/mocked contexts) does not escape the await.
  const safe = target => Promise.resolve().then(() => target());
  if (typeof context.addInitScript === 'function') {
    await safe(() => context.addInitScript(fingerprint)).catch(() => {});
  } else {
    for (const page of context.pages()) {
      if (typeof page.addInitScript === 'function') await safe(() => page.addInitScript(fingerprint)).catch(() => {});
    }
  }
  for (const page of context.pages()) {
    if (typeof page.evaluate === 'function') await safe(() => page.evaluate(fingerprint)).catch(() => {});
  }
}

export function runWorker({ stdin = process.stdin, stdout = process.stdout, exit = code => process.exit(code), launchContext = (...args) => chromium.launchPersistentContext(...args), captureInboxSnapshot = captureInbox, runProfileCampaign = runCampaign } = {}) {
  const input = createInterface({ input: stdin });
  const contexts = new Map();
  const bridges = new Set();
  let stopping = false;
  let started = false;
  let launchTask;
  let launchFinished = false;
  let stopPromise;
  let profileIds = [];
  let runSnapshot;
  const lastStatus = new Map();
  let syncingInbox = false;
  let campaignTask;
  const campaignAbort = new AbortController();
  let campaignStarted = false;
  const stoppedProfiles = new Set();
  async function stopProfile(index) {
    stoppedProfiles.add(index);
    const context = contexts.get(index);
    if (context) await context.close();
  }
  function launchCampaign(request) {
    if (campaignStarted || syncingInbox || stopping || request.runId !== runSnapshot?.runId) return;
    campaignStarted = true;
    runSnapshot.automation = request.automation ?? {};
    if (request.parserRequest) {
      const profiles = [...contexts].map(([index, context]) => ({
        id: profileIds[index], context,
        isStopped: () => stopping || stoppedProfiles.has(index) || contexts.get(index) !== context,
        emit: (level, message, extra = {}) => stdout.write(`${JSON.stringify({ type: 'campaign', id: profileIds[index], index, runId: runSnapshot.runId, level, message, phase: 'running', ...extra })}\n`),
        finish: async (sent, failed, stopped) => {
          stdout.write(`${JSON.stringify({ type: 'campaign', id: profileIds[index], index, runId: runSnapshot.runId, level: failed ? 'error' : 'info', message: stopped ? 'Профиль остановлен пользователем.' : failed ? 'Рассылка профиля остановлена после ошибки.' : 'Обработка профиля завершена.', sent, phase: failed || stopped ? 'halted' : 'complete' })}\n`);
          await stopProfile(index);
        },
      }));
      for (const p of profiles) {
        const index = profileIds.indexOf(p.id);
        if (lastStatus.get(index) !== 'ready' || !request.mailboxes?.[p.id] || typeof request.token !== 'string') {
          p.failed = true;
          p.emit('error', 'Аккаунт Gmail или сессия лицензии не готовы.');
        }
      }
      campaignTask = runCampaignCycles(runSnapshot, request, profiles, { sendCycle: runProfileCampaign, isStopped: () => stopping, signal: campaignAbort.signal });
      return;
    }
    campaignTask = Promise.all([...contexts].map(async ([index, context]) => {
      const emit = (level, message, extra = {}) => stdout.write(`${JSON.stringify({ type: 'campaign', id: profileIds[index], index, runId: runSnapshot.runId, level, message, phase: 'running', ...extra })}\n`);
      try {
        if (lastStatus.get(index) !== 'ready') throw new Error('Аккаунт Gmail не готов к отправке.');
        const mailbox = request.mailboxes?.[profileIds[index]];
        if (!mailbox || typeof request.token !== 'string') throw new Error('Нет подтверждённого почтового аккаунта или сессии лицензии.');
        emit('info', 'Профиль участвует в рассылке.', { phase: 'running' });
        const outcome = await runProfileCampaign(context, runSnapshot, { profileId: profileIds[index], mailbox,
          token: request.token, html: request.html ?? '', isStopped: () => stopping || stoppedProfiles.has(index) || contexts.get(index) !== context, emit });
        emit(outcome.halted && !outcome.stopped ? 'error' : 'info', outcome.halted ? (outcome.stopped ? 'Отправка профиля остановлена пользователем.' : 'Отправка профиля остановлена после ошибки.') : 'Обработка очереди профиля завершена.', { sent: outcome.sent, phase: outcome.halted ? 'halted' : 'complete' });
      } catch (error) {
        emit('error', error.message || 'Не удалось запустить очередь отправки.', { phase: 'halted' });
      } finally {
        try { await stopProfile(index); }
        catch { emit('error', 'Не удалось закрыть браузер остановленного профиля.', { phase: 'halted' }); }
      }
    }));
  }
  async function syncInboxes(requestId) {
    if (stopping || syncingInbox) return;
    syncingInbox = true;
    try {
      await Promise.all([...contexts].map(async ([index, context]) => {
        const send = payload => stdout.write(`${JSON.stringify({ type: 'inbox', id: profileIds[index], runId: runSnapshot?.runId, requestId, ...payload })}\n`);
        try {
          const page = context.pages().find(page => !page.isClosed() && isGmailMailbox(page.url()));
          if (!page || lastStatus.get(index) !== 'ready') throw new Error('Сначала подтвердите готовность аккаунта Gmail.');
          const snapshot = await captureInboxSnapshot(page);
          if (!stopping && contexts.get(index) === context) send({ snapshot: { profile_id: profileIds[index], ...snapshot } });
        } catch (error) {
          if (!stopping) send({ error: error.message || 'Не удалось снять отпечаток входящих.' });
        }
      }));
    } finally { syncingInbox = false; }
  }
  const report = (index, status, message = '', extra = {}) => {
    lastStatus.set(index, status);
    stdout.write(`${JSON.stringify({ index, id: profileIds[index], runId: runSnapshot?.runId, status, message, ...extra })}\n`);
  };
  async function checkAccounts(requestId) {
    if (stopping) return;
    for (const [index, context] of contexts) {
      report(index, 'checking', '', { checkId: requestId });
      try {
        const ready = context.pages().some(page => !page.isClosed() && isGmailMailbox(page.url()));
        if (contexts.get(index) !== context || stopping) continue;
        report(index, ready ? 'ready' : 'unready', ready ? '' : 'Войдите в Gmail: вкладка почты не найдена.', { checkId: requestId });
      } catch {
        if (contexts.has(index) && !stopping) report(index, 'unready', 'Не удалось проверить вкладки Gmail. Повторите проверку.', { checkId: requestId });
      }
    }
  }
  function stop() {
    if (stopPromise) return stopPromise;
    stopping = true;
    campaignAbort.abort();
    stopPromise = (async () => {
      await launchTask?.catch(() => {});
      await Promise.allSettled([...contexts.values()].map(context => context.close()));
      await campaignTask?.catch(() => {});
      await Promise.allSettled([...bridges].map(proxy => closeAnonymizedProxy(proxy, true)));
    })();
    return stopPromise;
  }
  let finishPromise;
  function finish(code = 0) {
    if (finishPromise) return finishPromise;
    finishPromise = stop().finally(() => exit(code));
    return finishPromise;
  }
  async function start({ profiles, proxies, directory, run }) {
    runSnapshot = run ? structuredClone(run) : null;
    profiles ??= proxies.map((proxy, index) => ({ id: String(index + 1), proxy }));
    profileIds = profiles.map(profile => profile.id);
    proxies = profiles.map(profile => profile.proxy);
    if (profileIds.some(id => !/^(?:[1-9]\d{0,8}|[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/.test(id)) || new Set(profileIds).size !== profileIds.length) throw new Error('Invalid profile IDs');
    if (profiles.some(p => p.directoryId !== undefined && !/^[1-9]\d{0,8}$/.test(p.directoryId))) throw new Error('Invalid profile directories');
    let validated;
    try { validated = proxies.map(parseProxy); }
    catch (error) { proxies.forEach((_, index) => report(index, 'error', error.message)); return; }
    for (const [index, proxy] of validated.entries()) {
      if (stopping) break;
      let bridge;
      try {
        report(index, 'starting');
        if (proxy) {
          const upstream = new URL(proxy);
          // The adapter must resolve destination hostnames at the SOCKS server.
          if (upstream.username || upstream.password) upstream.protocol = 'socks5h:';
          bridge = await anonymizeProxy({ url: upstream.href, port: 0 });
          bridges.add(bridge);
        }
        // Align the browser's clock and language with the proxy geo so Gmail does
        // not see a host-machine timezone mismatch; fall back to the host when the
        // run carries no selected geo or it is not mapped above.
        const fingerprint = geoFingerprint(runSnapshot?.config?.selectedGeos);
        const context = await launchContext(join(directory, `profile-${profiles[index].directoryId ?? profileIds[index]}`), {
          headless: false, ...(bridge ? { proxy: { server: bridge } } : {}), timeout: 45000,
          ...(fingerprint ? { timezoneId: fingerprint.timezoneId, locale: fingerprint.locale } : {}),
          args: [
            '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
            '--disable-blink-features=AutomationControlled',
            '--start-maximized',
          ],
        });
        contexts.set(index, context);
        await applyFingerprint(context);
        context.on('close', () => {
          contexts.delete(index);
          report(index, 'closed');
          if (bridge) void closeAnonymizedProxy(bridge, true).catch(() => {});
          bridges.delete(bridge);
          if (launchFinished && contexts.size === 0 && !stopping) void finish();
        });
        if (stopping) { await context.close(); break; }
        report(index, 'open');
        context.on('page', page => watchPage(page));
        function watchPage(page) {
          const invalidate = () => {
            if (stopping || !contexts.has(index)) return;
            if (lastStatus.get(index) === 'ready') {
              if (context.pages().some(tab => !tab.isClosed() && isGmailMailbox(tab.url()))) return;
              report(index, 'unready', 'Вкладка Gmail закрыта или выполнен выход. Повторите проверку готовности.');
            }
          };
          page.on?.('framenavigated', frame => {
            if (frame !== page.mainFrame() || stopping || !contexts.has(index)) return;
            invalidate();
          });
          page.on?.('close', invalidate);
        }
        context.pages().forEach(watchPage);
        let page;
        try { page = context.pages()[0] ?? await context.newPage(); }
        catch { if (!contexts.has(index) || stopping) continue; throw new Error('Page unavailable'); }
        // Navigation must not delay opening the remaining profiles or stopping them.
        void page.goto('https://gmail.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {
          if (!stopping && contexts.has(index)) report(index, 'open', 'Не удалось загрузить Gmail. Проверьте подключение и обновите страницу.');
        });
      } catch (error) {
        if (bridge) { await closeAnonymizedProxy(bridge, true).catch(() => {}); bridges.delete(bridge); }
        report(index, 'error', error.message.includes('Executable doesn\'t exist')
          ? 'Chromium не установлен. Выполните npm run browsers:install.'
          : 'Не удалось открыть браузер. Проверьте установку Chromium и доступность прокси.');
      }
    }
  }
  input.on('line', line => {
    if (started) {
      if (line === 'stop') { void finish(); return; }
      try {
        const request = JSON.parse(line);
        if (request.command === 'check' && typeof request.requestId === 'string') void checkAccounts(request.requestId);
        if (request.command === 'inbox' && typeof request.requestId === 'string') void syncInboxes(request.requestId);
        if (request.command === 'campaign') launchCampaign(request);
      } catch { /* Ignore malformed control messages. */ }
      return;
    }
    started = true;
    try { launchTask = start(JSON.parse(line)); }
    catch { void finish(1); return; }
    void launchTask.then(() => {
      launchFinished = true;
      if (contexts.size === 0 && !stopping) void finish();
    }, () => { void finish(1); });
  });
  input.on('close', () => { void finish(); });
  return { stop: finish, stopProfile, getRunSnapshot: () => runSnapshot ? structuredClone(runSnapshot) : null };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runWorker();
