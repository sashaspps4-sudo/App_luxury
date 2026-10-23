import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { anonymizeProxy, closeAnonymizedProxy } from 'proxy-chain';
import { PassThrough } from 'node:stream';
import { runWorker, isGmailMailbox } from './worker.mjs';

test('readiness accepts mailbox paths only on the exact HTTPS Gmail origin', () => {
  for (const url of ['https://mail.google.com/mail/u/0/', 'https://mail.google.com/mail/u/1/#inbox', 'https://mail.google.com/mail/u/12/?x=1']) assert.equal(isGmailMailbox(url), true, url);
  for (const url of ['https://accounts.google.com/', 'https://gmail.com/', 'https://mail.google.com/', 'https://mail.google.com/mail/u/0', 'https://mail.google.com.evil.test/mail/u/0/', 'http://mail.google.com/mail/u/0/', 'https://mail.google.com:1234/mail/u/0/', 'https://mail.google.com/mail/u/0x/', 'invalid']) assert.equal(isGmailMailbox(url), false, url);
});

test('readiness is per profile, repeatable, and does not change its captured config', { timeout: 10000 }, async () => {
  const { EventEmitter } = await import('node:events');
  const input = new PassThrough();
  const statuses = new Map();
  const contexts = [];
  const pages = [];
  const paths = [];
  const uuid = 'c24f671d-4b92-48e8-962b-55820dde9057';
  const run = { runId: 'run-test', configName: 'Config A', config: { workflowMode: 'funnel', templates: { Default: 'original' } } };
  const worker = runWorker({
    stdin: input, stdout: { write(line) { const entry = JSON.parse(line); statuses.set(entry.index, entry); } }, exit() {},
    launchContext: async path => {
      paths.push(path);
      const context = new EventEmitter();
      const page = new EventEmitter();
      page.address = 'https://accounts.google.com/';
      page.url = () => page.address;
      page.isClosed = () => false;
      page.goto = async () => {};
      page.mainFrame = () => page;
      pages.push(page);
      context.pages = () => [page];
      context.close = async () => context.emit('close');
      contexts.push(context);
      return context;
    },
  });
  try {
    input.write(JSON.stringify({ directory: 'test', profiles: [{ id: '1', proxy: '' }, { id: uuid, directoryId: '4', proxy: '' }], run }) + '\n');
    await waitFor(() => statuses.get(1)?.status === 'open');
    pages[0].address = 'https://mail.google.com/mail/u/0/#inbox';
    input.write(JSON.stringify({ command: 'check', requestId: 'check-1' }) + '\n');
    await waitFor(() => statuses.get(1)?.checkId === 'check-1' && statuses.get(1)?.status === 'unready');
    assert.equal(statuses.get(0).status, 'ready');
    assert.equal(statuses.get(0).runId, 'run-test');
    assert.equal(statuses.get(1).id, uuid);
    assert.deepEqual(paths, [join('test', 'profile-1'), join('test', 'profile-4')]);
    pages[0].address = 'https://mail.google.com/mail/u/0/#sent';
    pages[0].emit('framenavigated', pages[0]);
    assert.equal(statuses.get(0).status, 'ready');
    pages[0].address = 'https://accounts.google.com/';
    pages[0].emit('framenavigated', pages[0]);
    assert.equal(statuses.get(0).status, 'unready');
    pages[0].address = pages[1].address = 'https://mail.google.com/mail/u/1/';
    input.write(JSON.stringify({ command: 'check', requestId: 'check-2' }) + '\n');
    await waitFor(() => statuses.get(1)?.checkId === 'check-2' && statuses.get(1)?.status === 'ready');
    assert.equal(statuses.get(0).status, 'ready');
    const copy = worker.getRunSnapshot();
    copy.config.templates.Default = 'changed';
    assert.equal(worker.getRunSnapshot().config.templates.Default, 'original');
    await contexts[0].close();
    assert.equal(statuses.get(0).status, 'closed');
    assert.equal(statuses.get(1).status, 'ready');
  } finally { await worker.stop(); input.destroy(); }
});

test('a halted profile closes only its browser while another campaign continues', { timeout: 10000 }, async () => {
  const { EventEmitter } = await import('node:events');
  const input = new PassThrough();
  const contexts = [], entries = [];
  let release;
  const second = new Promise(resolve => { release = resolve; });
  let exited = false;
  const worker = runWorker({
    stdin: input, stdout: { write(line) { entries.push(JSON.parse(line)); } }, exit() { exited = true; },
    launchContext: async () => {
      const context = new EventEmitter();
      context.closed = false;
      const page = new EventEmitter();
      page.url = () => 'https://mail.google.com/mail/u/0/'; page.isClosed = () => context.closed;
      page.goto = async () => {}; page.mainFrame = () => page;
      context.pages = () => [page];
      context.close = async () => { if (!context.closed) { context.closed = true; context.emit('close'); } };
      contexts.push(context); return context;
    },
    runProfileCampaign: async (_context, _run, hooks) => {
      if (hooks.profileId === '1') return { sent: 0, halted: true };
      await second; return { sent: 2, halted: false };
    },
  });
  try {
    input.write(JSON.stringify({ directory: 'test', profiles: [{ id: '1', proxy: '' }, { id: '2', proxy: '' }], run: { runId: 'campaign-test', config: {} } }) + '\n');
    await waitFor(() => entries.filter(e => e.status === 'open').length === 2);
    input.write(JSON.stringify({ command: 'check', requestId: 'ready' }) + '\n');
    await waitFor(() => entries.filter(e => e.status === 'ready').length === 2);
    input.write(JSON.stringify({ command: 'campaign', runId: 'campaign-test', token: 'fake', mailboxes: { 1: 'one@example.com', 2: 'two@example.com' } }) + '\n');
    await waitFor(() => contexts[0].closed);
    assert.equal(contexts[1].closed, false); assert.equal(exited, false);
    assert.ok(entries.some(e => e.id === '2' && e.phase === 'running'));
    release();
    await waitFor(() => contexts[1].closed && exited);
    assert.ok(entries.some(e => e.id === '1' && e.phase === 'halted'));
    assert.ok(entries.some(e => e.id === '2' && e.phase === 'complete'));
  } finally { release(); await worker.stop(); input.destroy(); }
});

async function waitFor(check, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for browser lifecycle');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

test('manual browser closure preserves other profiles and allows relaunch of the same sessions', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'luxury-manual-close-'));
  const contexts = [];
  const paths = [];
  const input = new PassThrough();
  const statuses = new Map();
  let exitCode;
  const worker = runWorker({
    stdin: input,
    stdout: { write(line) { const entry = JSON.parse(line); statuses.set(entry.index, entry); } },
    exit(code) { exitCode = code; },
    async launchContext(...args) {
      paths.push(args[0]);
      const context = await chromium.launchPersistentContext(...args);
      await context.route('**/*', route => route.fulfill({ body: 'Gmail test page' }));
      contexts.push(context);
      return context;
    },
  });
  try {
    input.write(JSON.stringify({ directory, profiles: [{ id: '1', proxy: '' }, { id: '3', proxy: '' }] }) + '\n');
    await waitFor(() => statuses.get(0)?.status === 'open' && statuses.get(1)?.status === 'open');
    const session = await contexts[0].browser().newBrowserCDPSession();
    await session.send('Browser.close').catch(() => {});
    await waitFor(() => statuses.get(0)?.status === 'closed');
    assert.equal(statuses.get(1).status, 'open');
    assert.equal(exitCode, undefined);
    assert.equal(await contexts[1].pages()[0].evaluate(() => 1 + 1), 2);
    const lastSession = await contexts[1].browser().newBrowserCDPSession();
    await lastSession.send('Browser.close').catch(() => {});
    await waitFor(() => exitCode !== undefined);
    assert.equal(exitCode, 0);
    assert.equal(statuses.get(1).status, 'closed');
    assert.deepEqual(paths, [join(directory, 'profile-1'), join(directory, 'profile-3')]);
    assert.equal(statuses.get(1).id, '3');
    const restarted = await chromium.launchPersistentContext(join(directory, 'profile-3'), { headless: false });
    await restarted.close();
  } finally {
    await worker.stop();
    input.destroy();
    await Promise.allSettled(contexts.map(context => context.close()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('stop and stdin closure await the same cleanup before exiting', { timeout: 10000 }, async () => {
  const { EventEmitter } = await import('node:events');
  const input = new PassThrough();
  const context = new EventEmitter();
  let releaseClose;
  let closeCalls = 0;
  let exits = 0;
  const statuses = [];
  context.pages = () => [{ goto: async () => {} }];
  context.close = async () => {
    closeCalls++;
    await new Promise(resolve => { releaseClose = resolve; });
    context.emit('close');
  };
  runWorker({ stdin: input, stdout: { write: line => statuses.push(JSON.parse(line)) }, exit: () => exits++, launchContext: async () => context });
  input.write(JSON.stringify({ directory: 'test', proxies: [''] }) + '\n');
  await waitFor(() => statuses.some(item => item.status === 'open'));
  input.end('stop\n');
  await waitFor(() => closeCalls === 1);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(exits, 0);
  releaseClose();
  await waitFor(() => exits === 1);
  assert.equal(closeCalls, 1);
});

test('direct and proxied profiles open together, close, and release their session directories', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'luxury-browsers-'));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./worker.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'inherit'] });
  const exit = once(child, 'exit');
  const messages = createInterface({ input: child.stdout });
  const opened = new Set();
  const closed = new Set();
  try {
    const ready = new Promise((resolve, reject) => {
      messages.on('line', line => {
        const entry = JSON.parse(line);
        if (entry.status === 'error') reject(new Error(entry.message));
        if (entry.status === 'open') opened.add(entry.index);
        if (entry.status === 'closed') closed.add(entry.index);
        if (opened.size === 2) resolve();
      });
      child.on('exit', () => { if (opened.size !== 2) reject(new Error('Worker exited before opening profiles')); });
    });
    child.stdin.write(JSON.stringify({ directory, proxies: ['', 'socks5://user:secret@127.0.0.1:19002'] }) + '\n');
    await ready;
    child.stdin.write('stop\n');
    const [code] = await exit;
    assert.equal(code, 0);
    assert.equal(closed.size, 2);
  } finally {
    child.stdin.end();
    if (child.exitCode === null) { child.kill(); await exit; }
    await rm(directory, { recursive: true, force: true });
  }
});

test('authenticated SOCKS5 forwards browser traffic through the adapter', { timeout: 30000 }, async () => {
  let authenticated = false;
  let routed = false;
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let stage = 0;
    socket.on('data', data => {
      if (stage === 0) { socket.write(Buffer.from([5, 2])); stage = 1; }
      else if (stage === 1) {
        const length = data[1];
        authenticated = data.subarray(2, 2 + length).toString() === 'user' && data.subarray(3 + length).toString() === 'secret';
        socket.write(Buffer.from([1, authenticated ? 0 : 1])); stage = 2;
      } else if (stage === 2) { socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80])); stage = 3; }
      else { routed = true; socket.end('HTTP/1.1 200 OK\r\nContent-Length: 13\r\nConnection: close\r\n\r\nproxy-success'); }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let bridge;
  let browser;
  try {
    bridge = await anonymizeProxy(`socks5h://user:secret@127.0.0.1:${server.address().port}`);
    browser = await chromium.launch({ proxy: { server: bridge } });
    const page = await browser.newPage();
    await page.goto('http://luxury-proxy-test.invalid', { timeout: 15000 });
    assert.equal(await page.locator('body').innerText(), 'proxy-success');
    assert.ok(authenticated && routed);
  } finally {
    await browser?.close();
    if (bridge) await closeAnonymizedProxy(bridge, true);
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
});

test('profile timezone includes UK aliases and all supported European geos', async () => {
  const { geoFingerprint } = await import('./worker.mjs');
  assert.equal(geoFingerprint(['UK']).timezoneId, 'Europe/London');
  assert.equal(geoFingerprint(['USA']).timezoneId, 'America/Chicago');
  for (const geo of ['CZ', 'DK', 'GR', 'LT', 'RO']) assert.match(geoFingerprint([geo]).timezoneId, /^Europe\//);
});
