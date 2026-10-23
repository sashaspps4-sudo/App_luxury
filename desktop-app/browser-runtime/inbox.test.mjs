import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { chromium } from 'playwright';
import { captureInbox, readInboxDocument } from './inbox.mjs';
import { runWorker } from './worker.mjs';

const row = (thread, message, sender, hidden = false) => `<tr class="zA" ${hidden ? 'style="display:none"' : ''}><td><div class="yW"><span email="${sender}">Sender</span></div></td><td><span data-legacy-thread-id="${thread}" data-legacy-last-message-id="${message}" data-legacy-last-non-draft-message-id="${message}"></span></td></tr>`;
const documentHtml = (rows, next = false) => `<a href="https://accounts.google.com/SignOutOptions" aria-label="Google Account: User (owner@example.com)">Account</a><table>${rows}</table>${rows ? '' : '<div class="TC">No conversations found.</div>'}${next ? '<button role="button" onclick="window.nextInboxPage()"><span class="amJ"></span></button>' : ''}`;

test('extracts stable Gmail IDs, excludes Google domains and ignores hidden rows', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(documentHtml(row('ignored', 'one', 'no-reply@google.com') + row('accounts', 'two', 'no-reply@accounts.google.com') + row('reply', 'three', 'seller@example.com') + row('lookalike', 'five', 'seller@evilgoogle.com') + row('suffix', 'six', 'seller@google.com.example.org') + row('hidden', 'four', 'hidden@example.com', true)));
    const state = await page.evaluate(readInboxDocument);
    assert.equal(state.mailbox_email, 'owner@example.com');
    assert.equal(state.ignored, 2);
    assert.deepEqual(state.entries.map(entry => [entry.thread_id, entry.message_id]), [['reply', 'three'], ['lookalike', 'five'], ['suffix', 'six']]);
  } finally { await browser.close(); }
});

test('captures every inbox search page and restores #inbox on the same Gmail account index', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const navigations = [];
    let address = 'https://mail.google.com/mail/u/2/#sent';
    await page.exposeFunction('nextInboxPage', async () => {
      await page.setContent(documentHtml(row('second', 'message-2', 'second@example.com')));
    });
    const adapter = {
      url: () => address,
      isClosed: () => page.isClosed(),
      evaluate: fn => page.evaluate(fn),
      locator: (...args) => page.locator(...args),
      async goto(url) {
        address = url;
        navigations.push(url);
        await page.setContent(documentHtml(row('first', 'message-1', 'first@example.com') + row('ignored', 'google', 'no-reply@google.com'), true));
      },
    };
    const snapshot = await captureInbox(adapter);
    assert.equal(snapshot.entries.length, 2);
    assert.equal(snapshot.pages, 2);
    assert.equal(snapshot.ignored_count, 1);
    assert.equal(snapshot.moved_to_inbox, true);
    assert.deepEqual(navigations, ['https://mail.google.com/mail/u/2/#inbox', 'https://mail.google.com/mail/u/2/#search/in%3Ainbox', 'https://mail.google.com/mail/u/2/#inbox']);
  } finally { await browser.close(); }
});

test('an explicitly empty inbox produces a valid zero baseline', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    let address = 'https://mail.google.com/mail/u/0/#inbox';
    const result = await captureInbox({ url: () => address, isClosed: () => false,
      evaluate: fn => page.evaluate(fn), locator: (...args) => page.locator(...args),
      async goto(url) { address = url; await page.setContent(documentHtml('')); } });
    assert.equal(result.entries.length, 0);
    assert.equal(result.pages, 1);
    assert.equal(result.moved_to_inbox, false);
  } finally { await browser.close(); }
});

test('a worker syncs each ready profile independently and reports failures without losing ready status', async () => {
  const stdin = new PassThrough();
  const events = [];
  let index = 0;
  const contexts = [];
  const worker = runWorker({ stdin, stdout: { write: line => events.push(JSON.parse(line)) }, exit() {},
    async launchContext() {
      const id = index++;
      const page = { url: () => 'https://mail.google.com/mail/u/0/#inbox', isClosed: () => false, on() {}, goto: async () => {} };
      const context = { pages: () => [page], on() {}, close: async () => {}, id };
      contexts.push(context);
      page.id = id;
      return context;
    },
    async captureInboxSnapshot(page) {
      if (page.id === 1) throw new Error('Inbox unavailable');
      return { mailbox_email: 'owner@example.com', entries: [], ignored_count: 0, pages: 1, scanned_at: new Date().toISOString(), moved_to_inbox: false };
    },
  });
  const wait = async predicate => {
    const deadline = Date.now() + 3000;
    while (!predicate()) { assert.ok(Date.now() < deadline, 'worker timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  try {
    stdin.write(JSON.stringify({ profiles: [{ id: '1', proxy: '' }, { id: '3', proxy: '' }], directory: 'unused', run: { runId: 'run' } }) + '\n');
    await wait(() => events.filter(e => e.status === 'open').length === 2);
    stdin.write(JSON.stringify({ command: 'check', requestId: 'check' }) + '\n');
    await wait(() => events.filter(e => e.status === 'ready').length === 2);
    stdin.write(JSON.stringify({ command: 'inbox', requestId: 'sync' }) + '\n');
    await wait(() => events.filter(e => e.type === 'inbox').length === 2);
    const results = events.filter(e => e.type === 'inbox');
    assert.equal(results.find(e => e.id === '1').snapshot.profile_id, '1');
    assert.equal(results.find(e => e.id === '3').error, 'Inbox unavailable');
    assert.ok(results.every(e => e.runId === 'run' && e.requestId === 'sync'));
    assert.equal(events.filter(e => e.status === 'unready').length, 0);
  } finally { await worker.stop(); stdin.destroy(); }
});
