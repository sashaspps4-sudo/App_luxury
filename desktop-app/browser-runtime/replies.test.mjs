import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processReplies, sendReplyWithRecovery, latestMessage } from './replies.mjs';
import { renderVariables } from './sender.mjs';

test('all five variables are escaped and date is DD.MM.YYYY', () => {
  assert.equal(renderVariables('{item}|{name}|{price}|{link}|{data}', { title: '<Item>', seller: { name: 'A&B' }, price: 42, link: 'https://example.test/?a=1&b=2' }, true, new Date(2026, 11, 1)), '&lt;Item&gt;|A&amp;B|42|https://example.test/?a=1&amp;b=2|01.12.2026');
});

test('reply uses original listing, provider, reservation and confirmed outcome', async () => {
  const writes = [];
  const candidate = { id: 1, profile_id: '1', mailbox_email: 'me@test.io', thread_id: 'abc', message_id: 'def', sender_emails: ['seller@test.io'], ad_state_id: 7, matches: [{ ad_state_id: 7, platform: 'Depop', ad: { title: 'Item', seller: 'Alice', price: 25 } }] };
  const api = async (path, payload) => {
    if (path === '/v1/provider-links') return payload.link ? { status: 'ready', link: payload.link } : { status: 'reserved', claim_token: 'provider-token' };
    if (path.endsWith('/received')) return { received: true };
    if (payload) { writes.push([path, payload]); return path.endsWith('/claim') ? { claim_token: 'token' } : { status: 'sent' }; }
    if (path.includes('?')) return { items: path.endsWith('=0') ? [candidate] : [] };
    return candidate;
  };
  await processReplies({ pages: () => [{ isClosed: () => false, url: () => 'https://mail.google.com/mail/u/0/#inbox', evaluate: async () => 'Australia/Sydney' }] }, {
    run: { config: { serviceCode: 'Depop' } }, profileId: '1', mailbox: 'me@test.io', api, html: '{item} {name} {price} {link} {data}', isStopped: () => false, emit() {}, link: async () => 'https://example.test/',
    send: async (_page, _candidate, _body, hooks) => { await hooks.onReceived(); const body = await hooks.prepareBody(); assert.match(body, /^Item Alice 25 https:\/\/example.test\/ \d{2}\.\d{2}\.\d{4}$/); await hooks.claim(); },
  });
  assert.equal(writes.length, 2);
  assert.equal(writes[1][1].outcome, 'sent');
});

test('current date follows profile timezone across midnight and DST', () => {
  const now = new Date('2026-10-23T00:30:00Z');
  assert.equal(renderVariables('{data}', {}, false, now, 'America/Chicago'), '22.10.2026');
  assert.equal(renderVariables('{data}', {}, false, now, 'Australia/Sydney'), '23.10.2026');
  assert.equal(renderVariables('{data}', {}, false, new Date('2026-03-29T23:30:00Z'), 'Europe/Berlin'), '30.03.2026');
});

test('reply selector retries once before reservation, never after a reservation attempt', async () => {
  let attempts = 0, reloads = 0;
  const page = { isClosed: () => false, reload: async () => { reloads++; } };
  const hooks = { isStopped: () => false, claim: async () => {} };
  const timeout = () => Object.assign(new Error('missing'), { name: 'TimeoutError' });
  await sendReplyWithRecovery(page, {}, '', hooks, async () => { if (++attempts === 1) throw timeout(); });
  assert.equal(attempts, 2); assert.equal(reloads, 1);
  attempts = 0; reloads = 0;
  await assert.rejects(sendReplyWithRecovery(page, {}, '', hooks, async (_p, _c, _h, guarded) => { attempts++; await guarded.claim(); throw timeout(); }));
  assert.equal(attempts, 1); assert.equal(reloads, 0);
  await assert.rejects(sendReplyWithRecovery(page, {}, '', { ...hooks, claim: async () => { throw timeout(); } }, async (_p, _c, _h, guarded) => { await guarded.claim(); }));
  assert.equal(reloads, 0);
});
import { chromium } from 'playwright';

test('Gmail decimal message IDs normalize to inbox hex IDs and last author wins', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<div class="adn" data-legacy-message-id="old"><span class="gD" email="old@test.io"></span></div><div class="adn" data-message-id="#msg-f:255"><span class="gD" email="Seller@TEST.io"></span></div>');
    assert.deepEqual(await page.evaluate(latestMessage), { sender: 'seller@test.io', id: 'ff' });
  } finally { await browser.close(); }
});

test('retry discards only its own draft and a failed cleanup stops recovery', async () => {
  let discarded = 0, reloads = 0, attempts = 0;
  const page = { isClosed: () => false, reload: async () => { reloads++; } };
  const button = { filter() { return this; }, click: async () => { discarded++; } };
  const draft = { locator: () => button, waitFor: async () => {} };
  const hooks = { claim: async () => {}, isStopped: () => false };
  const timeout = () => Object.assign(new Error('missing'), { name: 'TimeoutError' });
  await sendReplyWithRecovery(page, {}, '', hooks, async (_p, _c, _h, guarded) => {
    if (++attempts === 1) { guarded.onDraft(draft); throw timeout(); }
  });
  assert.equal(discarded, 1); assert.equal(reloads, 1);
});

test('inline reply verifies latest sender, recipient and thread before one Send click', async () => {
  const { sendReply } = await import('./replies.mjs');
  const browser = await chromium.launch();
  const encode = value => Buffer.from(JSON.stringify([value])).toString('base64');
  const log = `1:${encode('#thread-f:255')};11:${encode('#msg-a:draft')}`;
  try {
    const context = await browser.newContext({ timezoneId: 'Australia/Sydney' });
    const page = await context.newPage();
    await context.route('https://mail.google.com/**', route => route.fulfill({ contentType: 'text/html', body: `
      <a href="SignOutOptions" aria-label="me@test.io"></a>
      <div class="adn" data-legacy-message-id="ff"><span class="gD" email="seller@test.io">Seller</span>
      <span class="ams bkH" role="link" onclick="document.querySelector('.ip').style.display='block'">Répondre</span></div>
      <div class="ip" style="display:none">
      <input name="draft" type="hidden" value="#msg-a:draft"><span email="seller@test.io"></span>
      <div contenteditable="true" role="textbox" g_editable="true" style="min-height:30px"><br></div>
      <div role="button" class="aoO" jslog="${log}" onclick="window.clicks=(window.clicks||0)+1;document.querySelector('.vh').style.display='block'">Envoyer</div>
      </div>
      <div class="vh" style="display:none"><span id="link_vsm" param="#thread-f:255"></span><span id="link_undo" jslog="11:${encode('#msg-a:draft')}"></span></div>
    ` }));
    await page.goto('https://mail.google.com/mail/u/0/#inbox');
    let claims = 0, received = 0;
    await sendReply(page, { thread_id: 'ff', message_id: 'ff', sender_emails: ['seller@test.io'] }, '<p>Hello</p>', { mailbox: 'me@test.io', isStopped: () => false, onReceived: async () => { received++; }, prepareBody: async () => { assert.equal(received, 1); return '<p>Hello</p>'; }, claim: async () => { claims++; } });
    assert.equal(received, 1);
    assert.equal(claims, 1);
    assert.equal(await page.evaluate(() => window.clicks), 1);
  } finally { await browser.close(); }
});

test('lost sent acknowledgements retry only persistence and never downgrade a confirmed send', async () => {
  for (const permanentlyLost of [false, true]) {
    let sends = 0, finishes = 0, reviews = 0;
    const candidate = { id: 1, profile_id: '1', mailbox_email: 'me@test.io', thread_id: 'ff', message_id: 'ff', sender_emails: ['seller@test.io'], ad_state_id: 7, matches: [{ ad_state_id: 7, platform: 'Depop', ad: { title: 'Item' } }] };
    const api = async (path, payload) => {
      if (!payload) return path.includes('?') ? { items: path.endsWith('=0') ? [candidate] : [] } : candidate;
      if (path.endsWith('/claim')) return { claim_token: 'token' };
      if (payload.outcome === 'needs_review') { reviews++; return {}; }
      finishes++;
      if (permanentlyLost || finishes === 1) throw new Error('lost acknowledgement');
      return { status: 'sent' };
    };
    const work = processReplies({ pages: () => [{ isClosed: () => false, url: () => 'https://mail.google.com/mail/u/0/' }] }, {
      run: { config: { serviceCode: 'Depop' } }, profileId: '1', mailbox: 'me@test.io', api, html: '<p>Reply</p>', isStopped: () => false, emit() {},
      send: async (_p, _c, _h, hooks) => { sends++; await hooks.claim(); },
    });
    if (permanentlyLost) await assert.rejects(work); else await work;
    assert.equal(sends, 1); assert.equal(reviews, 0); assert.equal(finishes, permanentlyLost ? 3 : 2);
  }
});

test('verified seller with ambiguous listings counts as received without sending', async () => {
  let received = 0, sent = 0;
  const candidate = { id: 1, status: 'needs_review', reason: 'ambiguous_sender_or_ad', profile_id: '1', mailbox_email: 'me@test.io', thread_id: 'ff', message_id: 'ff', sender_emails: ['seller@test.io'], matches: [{ ad_state_id: 1, platform: 'Depop', ad: {} }, { ad_state_id: 2, platform: 'Depop', ad: {} }] };
  const api = async (path, payload) => {
    if (path.endsWith('/received')) { assert.equal(payload.sender_email, 'seller@test.io'); received++; return { received: true }; }
    return path.includes('?') ? { items: path.endsWith('=0') ? [candidate] : [] } : candidate;
  };
  await processReplies({ pages: () => [{ isClosed: () => false, url: () => 'https://mail.google.com/mail/u/0/' }] }, {
    run: { config: { serviceCode: 'Depop' } }, profileId: '1', mailbox: 'me@test.io', api, html: '<p>Reply</p>', isStopped: () => false, emit() {},
    verify: async () => ({ id: 'ff', sender: 'seller@test.io' }), send: async () => { sent++; },
  });
  assert.equal(received, 1); assert.equal(sent, 0);
});
