import { generateLink, generateReservedLink } from './link-provider.mjs';
import { renderVariables, mailboxIdentity, insertRenderedHtml, composeProof, observeSendProof, recipientMatches, SendError } from './sender.mjs';

// Verify the actual last message, rather than the participants in an inbox row.
export function latestMessage() {
  const messages = [...document.querySelectorAll('.adn[data-message-id], .adn[data-legacy-message-id]')];
  const node = messages.at(-1);
  const sender = node?.querySelector('.gD[email]')?.getAttribute('email')?.trim().toLowerCase();
  const raw = node?.getAttribute('data-message-id');
  let id = node?.getAttribute('data-legacy-message-id');
  if (!id && /^#msg-f:\d+$/.test(raw ?? '')) id = BigInt(raw.slice(7)).toString(16);
  return { sender, id };
}

export async function verifyIncoming(page, candidate, { mailbox, isStopped }) {
  if (isStopped()) throw new Error('Проверка входящего остановлена.');
  const url = new URL(page.url());
  if (url.origin !== 'https://mail.google.com' || !/^\/mail\/u\/\d+\//.test(url.pathname) || !/^[a-zA-Z0-9:_#-]+$/.test(candidate.thread_id)) throw new Error('Некорректная цепочка Gmail.');
  if (await page.locator('[contenteditable="true"][g_editable="true"]').filter({ visible: true }).count()) throw new Error('Закройте открытый черновик перед проверкой входящего.');
  await page.goto(`${url.origin}${url.pathname}#inbox/${encodeURIComponent(candidate.thread_id)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(expected => [...document.querySelectorAll('.adn[data-message-id], .adn[data-legacy-message-id]')].some(node => {
    const raw = node.getAttribute('data-message-id');
    const id = node.getAttribute('data-legacy-message-id') || (/^#msg-f:\d+$/.test(raw ?? '') ? BigInt(raw.slice(7)).toString(16) : null);
    return id === expected;
  }), candidate.message_id, { timeout: 15000 });
  if (isStopped()) throw new Error('Проверка входящего остановлена.');
  if (await page.evaluate(mailboxIdentity) !== mailbox) throw new Error('Аккаунт Gmail изменился.');
  const latest = await page.evaluate(latestMessage);
  if (!latest.id || !latest.sender) throw new SendError('message_selector', 'Не удалось прочитать последнее сообщение Gmail.');
  if (latest.id !== candidate.message_id || latest.sender === mailbox || !candidate.sender_emails.includes(latest.sender)) throw new SendError('stale_incoming', 'Последнее сообщение или отправитель изменились.');
  return latest;
}

export async function sendReply(page, candidate, html, hooks) {
  return sendReplyWithRecovery(page, candidate, html, hooks);
}

export async function sendReplyWithRecovery(page, candidate, html, hooks, send = sendReplyOnce) {
  let reserved = false;
  let ownedDraft;
  const guarded = { ...hooks, onDraft: root => { ownedDraft = root; }, claim: async () => { reserved = true; await hooks.claim(); } };
  for (let attempt = 0; attempt < 2; attempt++) {
    if (hooks.isStopped()) throw new Error('Автоответ остановлен.');
    try { return await send(page, candidate, html, guarded); }
    catch (error) {
      if (error.code === 'stale_incoming' && !reserved && ownedDraft) {
        await ownedDraft.locator('[role="button"].oh').filter({ visible: true }).click({ timeout: 10000 });
        await ownedDraft.waitFor({ state: 'hidden', timeout: 10000 });
        ownedDraft = null;
      }
      const recoverable = error.name === 'TimeoutError' || error instanceof SendError && error.code.endsWith('_selector');
      if (attempt || reserved || error.unknown || !recoverable || hooks.isStopped() || page.isClosed()) throw error;
      if (ownedDraft) {
        await ownedDraft.locator('[role="button"].oh').filter({ visible: true }).click({ timeout: 10000 });
        await ownedDraft.waitFor({ state: 'hidden', timeout: 10000 });
        ownedDraft = null;
      }
      hooks.recovery?.('Селектор автоответа не найден. Обновляем цепочку и повторяем один раз.');
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    }
  }
}

export async function sendReplyOnce(page, candidate, html, { mailbox, claim, isStopped, onDraft = () => {}, onReceived = async () => {}, prepareBody }) {
  const recipient = candidate.sender_emails[0];
  const check = async () => {
    if (isStopped()) throw new Error('Автоответ остановлен.');
    const latest = await page.evaluate(latestMessage);
    if (await page.evaluate(mailboxIdentity) !== mailbox) throw new Error('Аккаунт Gmail изменился.');
    if (!latest.id || !latest.sender) throw new SendError('message_selector', 'Не удалось прочитать последнее сообщение Gmail.');
    if (latest.id !== candidate.message_id || latest.sender !== recipient) throw new SendError('stale_incoming', 'Последнее сообщение или отправитель изменились.');
  };
  await verifyIncoming(page, candidate, { mailbox, isStopped });
  await check();
  await onReceived();
  if (prepareBody) html = await prepareBody();
  await check();
  const message = page.locator('.adn[data-message-id], .adn[data-legacy-message-id]').last();
  await message.locator('[role="link"].ams.bkH').last().click({ timeout: 10000 });
  const editor = page.locator('[contenteditable="true"][role="textbox"][g_editable="true"]').filter({ visible: true });
  await editor.waitFor({ state: 'visible', timeout: 15000 });
  const root = page.locator('.ip').filter({ has: editor });
  if (await root.count() !== 1) throw new Error('Не удалось однозначно определить редактор ответа.');
  onDraft(root);
  await insertRenderedHtml(page, editor, html);
  await root.locator('[role="button"].aoO').filter({ visible: true }).waitFor({ state: 'visible', timeout: 15000 });
  let proof;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (isStopped()) throw new Error('Автоответ остановлен.');
    proof = await root.evaluate(composeProof);
    if (proof) break;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  if (!proof) throw new SendError('draft_selector', 'Нет подтверждения черновика ответа.');
  const expectedThread = /^[a-f0-9]+$/i.test(candidate.thread_id) ? `#thread-f:${BigInt('0x' + candidate.thread_id)}` : candidate.thread_id;
  if (proof.thread_ref !== expectedThread) throw new Error('Черновик относится к другой цепочке.');
  if (!await root.evaluate(recipientMatches, { recipient, mailbox })) throw new Error('Получатель ответа не подтверждён.');
  const expectedBody = await editor.evaluate(node => node.innerHTML);
  await check();
  await claim();
  await check();
  const current = await root.evaluate(composeProof);
  if (current?.draft_ref !== proof.draft_ref || current?.thread_ref !== proof.thread_ref) throw new Error('Черновик изменился.');
  if (!await root.evaluate(recipientMatches, { recipient, mailbox }) || await editor.evaluate(node => node.innerHTML) !== expectedBody) throw new Error('Получатель или содержимое изменились после подготовки.');
  await page.evaluate(observeSendProof, proof);
  try {
    await root.locator('[role="button"].aoO').filter({ visible: true }).click({ timeout: 10000 });
    await page.waitForFunction(() => !!window.__luxurySendProof, null, { timeout: 15000 });
    const receipt = await page.evaluate(() => window.__luxurySendProof);
    if (receipt?.draft_ref !== proof.draft_ref || receipt?.thread_ref !== proof.thread_ref) throw new Error('Не подтверждена отправка этого ответа.');
  } finally {
    await page.evaluate(() => { window.__luxurySendObserver?.disconnect(); delete window.__luxurySendProof; }).catch(() => {});
  }
}

export async function processReplies(context, { run, profileId, mailbox, api, html, isStopped, emit, send = sendReply, link = generateLink, verify = verifyIncoming }) {
  if (!html?.trim()) throw new Error('Для автоответов нужен HTML-шаблон.');
  let after = 0;
  while (!isStopped()) {
    const list = await api(`/v1/replies/candidates?eligible=true&limit=50&after_id=${after}`);
    if (!list.items.length) return;
    for (const item of list.items) {
      after = item.id;
      if (item.profile_id !== profileId || item.mailbox_email !== mailbox) continue;
      const candidate = await api(`/v1/replies/candidates/${item.id}`);
      const match = candidate.matches.find(match => match.ad_state_id === candidate.ad_state_id);
      if (!candidate.matches.some(match => match.platform.toLowerCase() === run.config.serviceCode.toLowerCase())) continue;
      let claimToken;
      let confirmed = false;
      try {
        if (isStopped()) return;
        const page = context.pages().find(page => !page.isClosed() && /^https:\/\/mail.google.com\/mail\/u\/\d+\//.test(page.url()));
        if (!page) throw new Error('Вкладка Gmail закрыта.');
        const identity = { profile_id: profileId, mailbox_email: mailbox, thread_id: candidate.thread_id, message_id: candidate.message_id, sender_email: candidate.sender_emails[0] };
        if (candidate.status === 'needs_review') {
          const incoming = await verify(page, candidate, { mailbox, isStopped });
          const receipt = await api(`/v1/replies/candidates/${item.id}/received`, { ...identity, sender_email: incoming.sender });
          if (receipt.received !== true) throw new Error('Сервер не подтвердил входящий ответ.');
          if (candidate.reason !== 'latest_sender_not_verified') continue;
        }
        if (!match?.ad) continue;
        const ad = { ...match.ad };
        await send(page, candidate, html, { mailbox, isStopped, recovery: message => emit('info', message),
          onReceived: async () => {
            const receipt = await api(`/v1/replies/candidates/${item.id}/received`, identity);
            if (receipt.received !== true) throw new Error('Сервер не подтвердил входящий ответ.');
          },
          prepareBody: async () => {
            if (html.includes('{link}')) ad.link = await generateReservedLink(run.config, ad, { api, kind: 'reply', jobId: item.id, profileId, mailbox, generate: link });
            const timeZone = html.includes('{data}') ? await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone) : undefined;
            return renderVariables(html, ad, true, new Date(), timeZone);
          }, claim: async () => {
          const receipt = await api(`/v1/replies/candidates/${item.id}/claim`, { profile_id: profileId, mailbox_email: mailbox, thread_id: candidate.thread_id, message_id: candidate.message_id, sender_email: candidate.sender_emails[0] });
          claimToken = receipt.claim_token;
          if (!claimToken) throw new Error('Нет резервирования автоответа.');
        } });
        confirmed = true;
        let saved = false, acknowledgementError;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const receipt = await api(`/v1/replies/candidates/${item.id}/finish`, { claim_token: claimToken, outcome: 'sent' });
            if (receipt.status !== 'sent') throw new Error('Статус sent не подтверждён.');
            saved = true; break;
          } catch (error) { acknowledgementError = error; }
        }
        if (!saved) throw acknowledgementError;
        emit('success', `Автоответ ${item.id} отправлен.`, { autoSent: 1 });
      } catch (error) {
        if (!claimToken && error.code === 'stale_incoming') {
          await api(`/v1/replies/candidates/${item.id}/review`, { profile_id: profileId, mailbox_email: mailbox, thread_id: candidate.thread_id, message_id: candidate.message_id, sender_email: candidate.sender_emails[0] });
          emit('info', `Автоответ ${item.id}: входящее устарело, требуется проверка. Переходим к следующему.`);
          continue;
        }
        if (claimToken && !confirmed) await api(`/v1/replies/candidates/${item.id}/finish`, { claim_token: claimToken, outcome: 'needs_review' }).catch(() => {});
        throw new Error(`Автоответ ${item.id}: ${error.message}`);
      }
    }
  }
}
