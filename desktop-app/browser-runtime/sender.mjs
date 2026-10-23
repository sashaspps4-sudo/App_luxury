import { processReplies } from './replies.mjs';
import { generateReservedLink } from './link-provider.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { createAutomation, checkCampaignInbox } from './automation.mjs';

export const digest = value => createHash('sha256').update(value).digest('hex');
export const lines = value => String(value ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
const escapeHtml = value => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

export function renderVariables(source, ad, html = false, now = new Date(), timeZone) {
  const rawName = ad.name || ad.seller || '';
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(now);
  const part = type => parts.find(part => part.type === type).value;
  const date = `${part('day')}.${part('month')}.${part('year')}`;
  const values = { item: String(ad.title ?? ''), name: typeof rawName === 'object' ? String(rawName.name ?? rawName.username ?? '') : String(rawName), price: String(ad.price ?? ''), link: String(ad.link ?? ''), data: date };
  return String(source).replace(/\{(item|name|price|link|data)\}/g, (match, key) => key === 'link' && ad.link == null ? match : html ? escapeHtml(values[key]) : values[key]);
}

export function prepareRendering(config, html = '') {
  const subjects = lines(config.subjectLines);
  if (!subjects.length) throw new SendError('subjects_empty', 'В конфиге не заполнены варианты темы письма.');
  const texts = lines(config.templates?.[config.serviceCode] || config.templates?.['Default (Общие)']);
  if (config.workflowMode === 'funnel' && !texts.length) throw new SendError('texts_empty', 'В конфиге нет непустых строк текста для воронки.');
  if (!['broadcast', 'funnel'].includes(config.workflowMode)) throw new SendError('mode_invalid', 'Не указан режим отправки.');
  if (config.workflowMode === 'broadcast' && !html.trim()) throw new SendError('html_empty', 'Не выбран или пуст HTML-шаблон рассылки.');
  return { mode: config.workflowMode, subjects, texts, html,
    renderDigest: digest(JSON.stringify({ mode: config.workflowMode, subjects, texts: config.workflowMode === 'funnel' ? texts : [], html: config.workflowMode === 'broadcast' ? html : '' })) };
}

export function renderJob(rendering, job, timeZone) {
  const now = new Date();
  const subject = renderVariables(rendering.subjects[job.ordinal % rendering.subjects.length], job.ad, false, now, timeZone).replace(/[\r\n]/g, ' ').trim();
  const html = rendering.mode === 'broadcast';
  const body = renderVariables(html ? rendering.html : rendering.texts[job.ordinal % rendering.texts.length], job.ad, html, now, timeZone);
  if (!subject || !body.trim()) throw new SendError('content_empty', 'Тема или содержимое письма пусты после подстановки переменных.');
  return { subject, body, html };
}

export class SendError extends Error {
  constructor(code, message, unknown = false) { super(message); this.code = code; this.unknown = unknown; }
}

export function mailboxIdentity() {
  const label = document.querySelector('a[href*="SignOutOptions"]')?.getAttribute('aria-label') ?? '';
  const pattern = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig;
  return (label.match(pattern) ?? document.title.match(pattern) ?? []).at(-1)?.toLowerCase() ?? null;
}

export function composeProof(root) {
  let draft = root.querySelector('input[name="draft"]')?.value;
  const log = root.querySelector('[role="button"].aoO:not([contenteditable] *)')?.getAttribute('jslog') ?? '';
  if (!draft) {
    try {
      const ids = log.match(/(?:^|;)\s*11:([^;\s]+)/)?.[1];
      draft = JSON.parse(atob(ids.replace(/-/g, '+').replace(/_/g, '/').replace(/\./g, '=')))?.[0];
    } catch { /* Inline replies may expose the draft ID only in their send metadata. */ }
  }
  const encoded = log.match(/(?:^|;)\s*1:([^;\s]+)/)?.[1];
  let thread;
  try { thread = JSON.parse(atob(encoded.replace(/-/g, '+').replace(/_/g, '/').replace(/\./g, '=')))?.[0]; } catch { /* A draft still being created has no stable IDs. */ }
  return /^#msg-[af]:[A-Za-z0-9_-]+$/.test(draft ?? '') && /^#thread-[af]:[A-Za-z0-9_-]+$/.test(thread ?? '') ? { draft_ref: draft, thread_ref: thread } : null;
}

export function recipientMatches(root, { recipient, mailbox }) {
  const inputs = [...root.querySelectorAll('input[name="to"],textarea[name="to"],input[name="cc"],input[name="bcc"]')].flatMap(node => node.value.split(/[,;]/).map(value => value.trim().toLowerCase())).filter(Boolean);
  const chips = [...root.querySelectorAll('[email],[data-email],[data-hovercard-id]')].flatMap(node => ['email', 'data-email', 'data-hovercard-id'].map(name => node.getAttribute(name)?.trim().toLowerCase())).filter(Boolean);
  const addresses = new Set([...inputs, ...chips].filter(address => address !== mailbox || address === recipient));
  return addresses.size === 1 && addresses.has(recipient);
}

export function observeSendProof(expected) {
  window.__luxurySendObserver?.disconnect();
  const existing = new WeakSet([...document.querySelectorAll('.vh')].filter(node => node.getClientRects().length && node.querySelector('#link_vsm')?.getAttribute('param') === expected.thread_ref));
  window.__luxurySendProof = null;
  const observer = new MutationObserver(() => {
    for (const toast of document.querySelectorAll('.vh')) {
      if (existing.has(toast) || !toast.getClientRects().length) continue;
      if (toast.querySelector('#link_vsm')?.getAttribute('param') !== expected.thread_ref) continue;
      const log = toast.querySelector('#link_undo')?.getAttribute('jslog') ?? '';
      const encoded = log.match(/(?:^|;)\s*11:([^;\s]+)/)?.[1];
      if (encoded) {
        try {
          const ids = JSON.parse(atob(encoded.replace(/-/g, '+').replace(/_/g, '/').replace(/\./g, '=')));
          if (ids[0] !== expected.draft_ref) continue;
        } catch { continue; }
      }
      window.__luxurySendProof = expected;
      observer.disconnect();
      break;
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  window.__luxurySendObserver = observer;
}

// Run inside the editor's page. Styles are rendered in a script-disabled,
// network-disabled frame, then inlined so they cannot restyle the Gmail UI.
export async function insertHtml(editor, html) {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  parsed.querySelectorAll('script,iframe,object,embed,form,input,button,textarea,select,meta,link,base,svg,math').forEach(node => node.remove());
  for (const node of parsed.querySelectorAll('*')) {
    for (const attribute of [...node.attributes]) {
      if (/^on/i.test(attribute.name) || ['srcdoc', 'srcset'].includes(attribute.name)) node.removeAttribute(attribute.name);
      if (['href', 'src', 'background', 'xlink:href'].includes(attribute.name) && !/^(https?:|mailto:|cid:|#|data:image\/(png|jpeg|gif|webp);)/i.test(attribute.value.trim())) node.removeAttribute(attribute.name);
    }
  }
  const csp = parsed.createElement('meta');
  csp.httpEquiv = 'Content-Security-Policy';
  csp.content = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";
  parsed.head.prepend(csp);
  const frame = document.createElement('iframe');
  frame.sandbox = 'allow-same-origin';
  frame.style.cssText = 'position:fixed;left:-10000px;width:640px;height:480px;visibility:hidden;';
  const loaded = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('html_render_timeout')), 5000);
    frame.onload = () => { clearTimeout(timer); resolve(); };
  });
  frame.srcdoc = parsed.documentElement.outerHTML;
  document.body.append(frame);
  try {
    await loaded;
    const doc = frame.contentDocument;
    const rules = [];
    const visit = list => { for (const rule of list) {
      if (rule.type === 1) rules.push(rule);
      else if (rule.cssRules && (!rule.conditionText || frame.contentWindow.matchMedia(rule.conditionText).matches)) visit(rule.cssRules);
    } };
    for (const sheet of doc.styleSheets) { try { visit(sheet.cssRules); } catch { /* External CSS is intentionally disabled. */ } }
    const nodes = [doc.body, ...doc.body.querySelectorAll('*')];
    if (nodes.length > 5000) throw new Error('html_too_complex');
    for (const node of nodes) {
      const computed = frame.contentWindow.getComputedStyle(node);
      const properties = new Set();
      for (const rule of rules) { try { if (node.matches(rule.selectorText)) for (const property of rule.style) properties.add(property); } catch { /* Unsupported pseudo-elements cannot be pasted into an email. */ } }
      for (const property of properties) node.style.setProperty(property, computed.getPropertyValue(property));
    }
    doc.querySelectorAll('style').forEach(node => node.remove());
    for (const node of doc.querySelectorAll('*')) {
      for (const name of ['id', 'contenteditable', 'g_editable', 'email', 'data-email', 'data-hovercard-id']) node.removeAttribute(name);
    }
    const wrapper = document.createElement('div');
    wrapper.style.cssText = doc.body.style.cssText;
    for (const node of [...doc.body.childNodes]) wrapper.append(document.importNode(node, true));
    editor.focus();
    editor.replaceChildren(wrapper);
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
  } finally { frame.remove(); }
}

// Parse and render away from Gmail's Trusted Types policy. Transfer a DOM tree,
// never an HTML string, into Gmail so its security policy remains intact.
export async function insertRenderedHtml(page, body, html) {
  const renderer = await page.context().newPage();
  try {
    const editor = renderer.locator('body');
    await editor.evaluate(insertHtml, html);
    const tree = await editor.evaluate(root => {
      const serialize = node => node.nodeType === Node.TEXT_NODE
        ? { text: node.textContent }
        : node.nodeType === Node.ELEMENT_NODE
          ? { tag: node.localName, attrs: [...node.attributes].map(attr => [attr.name, attr.value]), children: [...node.childNodes].map(serialize).filter(Boolean) }
          : null;
      return [...root.childNodes].map(serialize).filter(Boolean);
    });
    await body.evaluate((editor, tree) => {
      const restore = item => {
        if ('text' in item) return document.createTextNode(item.text);
        const node = document.createElement(item.tag);
        for (const [name, value] of item.attrs) node.setAttribute(name, value);
        for (const child of item.children) node.append(restore(child));
        return node;
      };
      editor.focus();
      editor.replaceChildren(...tree.map(restore));
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
    }, tree);
  } finally { await renderer.close(); }
}

export async function typeMessage(body, text, { isStopped = () => false, random = Math.random, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const stopped = () => { if (isStopped()) throw new SendError('stopped', 'Ввод текста остановлен. Письмо не отправлено.'); };
  const pause = async duration => {
    for (let remaining = duration; remaining > 0; remaining -= 50) {
      stopped();
      await sleep(Math.min(50, remaining));
    }
    stopped();
  };
  stopped();
  await body.fill('');
  await body.focus();
  const source = String(text).replace(/\r\n?/g, '\n');
  const characters = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(source);
  let pace = 45 + random() * 45;
  for (const { segment } of characters) {
    stopped();
    if (!await body.evaluate(editor => document.activeElement === editor || editor.contains(document.activeElement))) {
      throw new SendError('body_focus_lost', 'Редактор Gmail потерял фокус во время ввода. Письмо не отправлено.');
    }
    if (segment === '\n') await body.press('Shift+Enter');
    else await body.pressSequentially(segment);
    let delay = pace * (0.6 + random() * 1.1);
    if (segment === '\n') delay += 350 + random() * 500;
    else if (/[.!?…]/u.test(segment)) delay += 200 + random() * 400;
    else if (/[,;:]/u.test(segment)) delay += 100 + random() * 200;
    else if (/\s/u.test(segment)) {
      delay += 60 + random() * 140;
      pace = 45 + random() * 45;
    }
    await pause(delay);
  }
}

export async function sendOne(page, job, content, { mailbox, claim, isStopped = () => false, progress = () => {}, selectorTimeout = 15000, confirmTimeout = 30000, typing = {} } = {}) {
  let reserved = false;
  const stopped = () => { if (isStopped()) throw new SendError('stopped', 'Отправка остановлена.', reserved); };
  const locate = async (locator, code, description) => {
    try { await locator.waitFor({ state: 'visible', timeout: selectorTimeout }); return locator; }
    catch { throw new SendError(code, `Не найден селектор: ${description}.`, reserved); }
  };
  stopped();
  if (await page.evaluate(mailboxIdentity) !== mailbox) throw new SendError('mailbox_changed', 'Почтовый аккаунт не совпадает с сохранённым отпечатком.');
  const dialogs = page.locator('[role="dialog"]').filter({ has: page.locator('input[name="subjectbox"]') }).filter({ visible: true });
  if (await dialogs.count()) throw new SendError('existing_compose', 'Уже открыто окно письма. Закройте его перед запуском рассылки.');
  progress('Открываем редактор письма.');
  await (await locate(page.locator('[gh="cm"][role="button"]').filter({ visible: true }).first(), 'compose_selector', '[gh="cm"][role="button"]')).click();
  const dialog = await locate(dialogs.first(), 'dialog_selector', 'окно письма [role="dialog"] с input[name="subjectbox"]');
  if (await dialogs.count() !== 1) throw new SendError('multiple_compose', 'Открыто несколько окон письма. Отправка остановлена.');
  const to = await locate(dialog.locator('input[role="combobox"][peoplekit-id], input[name="to"], textarea[name="to"]').filter({ visible: true }).first(), 'recipient_selector', 'поле получателя To');
  await to.fill(job.recipient);
  await to.press('Enter');
  const recipientDeadline = Date.now() + selectorTimeout;
  let recipientAccepted = false;
  while (Date.now() < recipientDeadline) {
    recipientAccepted = await dialog.evaluate(recipientMatches, { recipient: job.recipient, mailbox });
    if (recipientAccepted) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!recipientAccepted) throw new SendError('recipient_not_accepted', 'Gmail не подтвердил ровно одного нужного получателя.');
  const subject = await locate(dialog.locator('input[name="subjectbox"]'), 'subject_selector', 'input[name="subjectbox"]');
  await subject.fill(content.subject);
  const body = await locate(dialog.locator('[contenteditable="true"][role="textbox"][g_editable="true"]'), 'body_selector', 'редактор тела письма [contenteditable="true"][g_editable="true"]');
  try {
    if (content.html) await insertRenderedHtml(page, body, content.body);
    else {
      progress('Набираем текст письма.');
      await typeMessage(body, content.body, { ...typing, isStopped });
    }
  } catch (error) {
    if (error instanceof SendError) throw error;
    if (!content.html) throw new SendError('body_insert_failed', 'Не удалось набрать текст в редакторе Gmail. Письмо не отправлено.');
    const reason = /TrustedHTML|Trusted Types|trusted-types/i.test(String(error)) ? 'Браузер отклонил HTML по политике Trusted Types.'
      : /html_render_timeout/.test(String(error)) ? 'Истекло время отрисовки HTML.'
      : /html_too_complex/.test(String(error)) ? 'HTML содержит больше 5000 элементов.'
      : 'Ошибка обработки HTML или доступа к редактору.';
    throw new SendError('body_insert_failed', `Не удалось вставить содержимое в редактор Gmail. ${reason}`);
  }
  const send = await locate(dialog.locator('[role="button"].aoO:not([contenteditable] *)').filter({ visible: true }).first(), 'send_selector', 'кнопка отправки [role="button"].aoO');
  let expected;
  const deadline = Date.now() + selectorTimeout;
  while (Date.now() < deadline) {
    stopped();
    expected = await dialog.evaluate(composeProof);
    if (expected) break;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  if (!expected) throw new SendError('draft_ids_missing', 'Не получены ID черновика и цепочки Gmail.');
  stopped();
  if (await page.evaluate(mailboxIdentity) !== mailbox) throw new SendError('mailbox_changed', 'Аккаунт Gmail изменился перед отправкой.');
  if (!await dialog.evaluate(recipientMatches, { recipient: job.recipient, mailbox })) throw new SendError('recipient_changed', 'Получатель изменился перед отправкой.');
  progress('Письмо подготовлено.');
  // A lost claim response is ambiguous too: never click until the reservation is confirmed.
  reserved = true;
  await claim({ ...expected, subject_hash: digest(content.subject), body_hash: digest(content.body) });
  stopped();
  const currentProof = await dialog.evaluate(composeProof);
  if (await page.evaluate(mailboxIdentity) !== mailbox || currentProof?.draft_ref !== expected.draft_ref || currentProof?.thread_ref !== expected.thread_ref || !await dialog.evaluate(recipientMatches, { recipient: job.recipient, mailbox }) || await subject.inputValue() !== content.subject) {
    throw new SendError('compose_changed', 'Аккаунт, черновик, получатель или тема изменились после подготовки. Отправка отменена.', true);
  }
  await page.evaluate(observeSendProof, expected);
  try {
    progress('Отправляем письмо.');
    await send.click({ timeout: selectorTimeout });
    await page.waitForFunction(() => !!window.__luxurySendProof, null, { timeout: confirmTimeout });
    const proof = await page.evaluate(() => window.__luxurySendProof);
    if (proof?.thread_ref !== expected.thread_ref || proof?.draft_ref !== expected.draft_ref) throw new Error('proof_mismatch');
    await dialog.waitFor({ state: 'hidden', timeout: selectorTimeout });
    return proof;
  } catch {
    throw new SendError('send_unconfirmed', 'Не удалось подтвердить отправку. Повтор остановлен, чтобы не отправить письмо дважды.', true);
  } finally {
    await page.evaluate(() => { window.__luxurySendObserver?.disconnect(); delete window.__luxurySendProof; }).catch(() => {});
  }
}

export async function sendWithRecovery(page, job, content, hooks, sendImpl = sendOne) {
  let reserved = false;
  const guardedHooks = { ...hooks, claim: async metadata => { reserved = true; return hooks.claim(metadata); } };
  for (let attempt = 0; attempt < 2; attempt++) {
    if (hooks.isStopped()) throw new SendError('stopped', 'Отправка остановлена.');
    try { return await sendImpl(page, job, content, guardedHooks); }
    catch (error) {
      const selectorMissing = error instanceof SendError && error.code.endsWith('_selector');
      if (attempt !== 0 || reserved || error.unknown || (!selectorMissing && error.name !== 'TimeoutError') || hooks.isStopped() || page.isClosed()) throw error;
      hooks.recovery?.('error', error.message);
      hooks.recovery?.('info', 'Перезагружаем входящие в этой вкладке. Повторная попытка: 1 из 1.');
      const inbox = new URL(page.url());
      if (inbox.origin !== 'https://mail.google.com' || !/^\/mail\/u\/\d+\//.test(inbox.pathname)) throw new SendError('mailbox_missing', 'Вкладка Gmail изменилась. Повтор остановлен.');
      const target = `${inbox.origin}${inbox.pathname}#inbox`;
      try {
        await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 15000 });
        if (hooks.isStopped()) throw new SendError('stopped', 'Отправка остановлена.');
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForFunction(mailboxIdentity, null, { timeout: 15000 });
      } catch (navigationError) {
        if (navigationError instanceof SendError) throw navigationError;
        throw new SendError('inbox_reload_failed', 'Не удалось перезагрузить входящие для повторной попытки.');
      }
    }
  }
}

export async function recoverAfterUnknown(context, mailbox, isStopped) {
  if (isStopped()) throw new Error('Отправка остановлена.');
  const page = context.pages().find(page => !page.isClosed() && /^https:\/\/mail\.google\.com\/mail\/u\/\d+\//.test(page.url()));
  if (!page) throw new Error('Вкладка Gmail закрыта.');
  // Reload preserves any uncertain draft in Gmail; never discard or resend it.
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(mailboxIdentity, null, { timeout: 15000 });
  if (isStopped() || await page.evaluate(mailboxIdentity) !== mailbox) throw new Error('Аккаунт изменился или отправка остановлена.');
  if (await page.locator('[contenteditable="true"][g_editable="true"]').filter({ visible: true }).count()) throw new Error('Не закрыт редактор предыдущего письма. Черновик сохранён для проверки.');
}

export async function runCampaign(context, run, { profileId, mailbox, token, html, isStopped, emit, fetchImpl = fetch, sendImpl = sendOne, checkInboxImpl, automationClock = {} }) {
  const rendering = prepareRendering(run.config, html);
  const api = async (path, payload, timeout = 30000) => {
    let response;
    try { response = await fetchImpl(`https://api.luxmail.lol${path}`, { method: payload === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(timeout) }); }
    catch { throw new SendError('api_unavailable', 'Не удалось связаться с сервером рассылки.'); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new SendError('api_rejected', typeof data.detail === 'string' ? data.detail : 'Сервер отклонил операцию отправки.');
    return data;
  };
  const { jobs } = await api('/v1/outbound/prepare', { run_id: run.runId, profile_id: profileId, mailbox_email: mailbox, mode: rendering.mode, render_digest: rendering.renderDigest });
  let sent = 0, uncertain = 0;
  const scheduler = run.automation ? createAutomation(run.automation, {
    checkInbox: async () => {
      const receipt = await (checkInboxImpl ? checkInboxImpl() : checkCampaignInbox(context, { profileId, mailbox, api, isStopped, emit }));
      await processReplies(context, { run, profileId, mailbox, api, html, isStopped, emit });
      return receipt;
    },
    isStopped, emit: (level, message, extra = {}) => emit(level, message, { sent, ...extra }), ...automationClock,
  }) : null;
  const alreadySent = jobs.filter(job => job.status === 'sent').length;
  emit('info', `Очередь подготовлена: ${jobs.length}; отправлено ранее: ${alreadySent}.`, { sent });
  for (const job of jobs) {
    if (isStopped()) {
      emit('info', 'Очередь остановлена пользователем. Новые письма не отправляются.', { sent });
      return { sent, halted: true, stopped: true };
    }
    if (job.status !== 'pending') {
      emit(job.status === 'sent' ? 'info' : 'error', `Задание ${job.id}: статус ${job.status}; повторная отправка пропущена.`, { sent });
      continue;
    }
    if (scheduler?.config.maxPerProfile && sent + uncertain >= scheduler.config.maxPerProfile) {
      emit('info', `Достигнут лимит профиля: ${sent + uncertain} (включая неподтверждённые отправки). Оставшиеся задания не отправляются.`, { sent });
      break;
    }
    try { await scheduler?.beforeSend(); }
    catch (error) {
      if (!isStopped()) emit('error', `Проверка входящих остановила очередь: ${error.message}`, { sent });
      return { sent, halted: true, stopped: isStopped() };
    }
    const attempt = randomUUID();
    let claimed = false;
    let confirmed = false;
    let proof;
    try {
      const page = context.pages().find(page => !page.isClosed() && /^https:\/\/mail\.google\.com\/mail\/u\/\d+\//.test(page.url()));
      if (!page) throw new SendError('mailbox_missing', 'Не найдена открытая вкладка Gmail.');
      const source = rendering.subjects[job.ordinal % rendering.subjects.length] + (rendering.mode === 'broadcast' ? rendering.html : rendering.texts[job.ordinal % rendering.texts.length]);
      let renderedJob = job;
      if (source.includes('{link}')) {
        let link;
        try { link = await generateReservedLink(run.config, job.ad, { api, kind: 'outbound', jobId: job.id, profileId, mailbox }); }
        catch (error) { throw new SendError('link_generation_failed', error.message); }
        emit('success', `Задание ${job.id}: ссылка успешно создана (${run.config.provider}).`, { sent });
        if (isStopped()) throw new SendError('stopped', 'Отправка остановлена.');
        renderedJob = { ...job, ad: { ...job.ad, link } };
      }
      const timeZone = source.includes('{data}') ? await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone) : undefined;
      const content = renderJob(rendering, renderedJob, timeZone);
      if (renderedJob !== job) {
        const bodySource = rendering.mode === 'broadcast' ? rendering.html : rendering.texts[job.ordinal % rendering.texts.length];
        if (bodySource.includes('{link}')) {
          emit('success', `Задание ${job.id}: ссылка подставлена в ${content.html ? 'HTML письма' : 'текст письма'} вместо {link}.`, { sent });
        }
        if (rendering.subjects[job.ordinal % rendering.subjects.length].includes('{link}')) {
          emit('success', `Задание ${job.id}: ссылка подставлена в тему письма вместо {link}.`, { sent });
        }
      }
      proof = await sendWithRecovery(page, job, content, { mailbox, isStopped,
        recovery: (level, message) => emit(level, `Задание ${job.id}: ${message}`, { sent }),
        progress: message => emit('info', `Задание ${job.id}: ${message}`, { sent }),
        claim: async metadata => {
          claimed = true;
          const reservation = await api(`/v1/outbound/${job.id}/claim`, { run_id: run.runId, profile_id: profileId, mailbox_email: mailbox, attempt_id: attempt, ...metadata });
          if (reservation.status !== 'sending') throw new SendError('claim_not_confirmed', 'Сервер не подтвердил резервирование отправки.');
        },
      }, sendImpl);
      confirmed = true;
      let saved = false;
      let acknowledgementError;
      // Retrying this acknowledgement cannot send another email: the same
      // attempt/proof is idempotent at the API. Never retry the Send click.
      for (let retry = 0; retry < 3; retry++) {
        try {
          const receipt = await api(`/v1/outbound/${job.id}/finish`, { attempt_id: attempt, status: 'sent', ...proof }, 10000);
          if (receipt.status !== 'sent') throw new SendError('receipt_not_confirmed', 'Сервер не подтвердил запись sent.');
          saved = true;
          break;
        } catch (error) { acknowledgementError = error; }
      }
      if (!saved) throw acknowledgementError;
      sent++;
      scheduler?.noteSent();
      emit('success', `Письмо успешно отправлено. Задание ${job.id}.`, { sent });
    } catch (error) {
      // If Gmail confirmed but the DB acknowledgement failed, do not downgrade
      // to failed/unknown or continue sending. Reconcile the same attempt later.
      if (confirmed) {
        emit('error', `Письмо по заданию ${job.id} отправлено, но не удалось обновить его статус. Очередь остановлена.`, { sent });
      } else {
        const unknown = claimed || error.unknown;
        const code = error instanceof SendError ? error.code : 'browser_operation_failed';
        let recorded = false;
        try {
          const receipt = await api(`/v1/outbound/${job.id}/finish`, { attempt_id: attempt, status: unknown ? 'unknown' : 'failed', error_code: code });
          recorded = receipt.status === (unknown ? 'unknown' : 'failed');
        } catch { /* A missing durable outcome must halt rather than advance. */ }
        emit('error', `Задание ${job.id}: ${error instanceof SendError ? error.message : 'Ошибка работы с редактором Gmail.'} Статус: ${unknown ? 'unknown' : 'failed'}.`, { sent });
        if (code === 'send_unconfirmed' && unknown && recorded && !isStopped()) {
          uncertain++;
          scheduler?.noteSent();
          emit('info', `Задание ${job.id} оставлено в unknown и повторно не отправляется. Продолжаем очередь.`, { sent });
          const hasNext = jobs.slice(jobs.indexOf(job) + 1).some(next => next.status === 'pending');
          if (hasNext || scheduler?.config.afterQueue === 'monitor') {
            try { await recoverAfterUnknown(context, mailbox, isStopped); }
            catch (recoveryError) {
              emit('error', `Не удалось подготовить Gmail для следующего письма: ${recoveryError.message}`, { sent });
              return { sent, halted: true, stopped: isStopped() };
            }
          }
          continue;
        }
      }
      return { sent, halted: true };
    }
  }
  try { await scheduler?.finish(); }
  catch (error) {
    if (!isStopped()) emit('error', `Автоматизация остановлена: ${error.message}`, { sent });
    return { sent, halted: true, stopped: isStopped() };
  }
  emit('info', `Очередь завершена. Подтверждено отправок: ${sent}.`, { sent });
  return { sent, halted: false };
}
