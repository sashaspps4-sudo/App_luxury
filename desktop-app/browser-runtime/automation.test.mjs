import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutomation, normalizeAutomation, checkCampaignInbox } from './automation.mjs';
import { runCampaign } from './sender.mjs';

test('automation rejects inconsistent settings', () => {
  for (const settings of [{ delayMinSeconds: 3, delayMaxSeconds: 2 }, { checkEverySent: -1 }, { pauseEverySent: 2, pauseSeconds: 0 }, { afterQueue: 'monitor', checkEverySeconds: 0 }]) assert.throws(() => normalizeAutomation(settings));
});

test('only count checks run during sending; timed checks stay inactive during pauses', async () => {
  let time = 0, checks = 0;
  const scheduler = createAutomation({ delayMinSeconds: 1, delayMaxSeconds: 1, checkEverySent: 2, checkEverySeconds: 60, pauseEverySent: 2, pauseSeconds: 125 }, {
    now: () => time, sleep: async ms => { time += ms; }, random: () => 0, isStopped: () => false, emit() {},
    checkInbox: async () => { checks++; return {}; },
  });
  await scheduler.beforeSend();
  scheduler.noteSent();
  await scheduler.beforeSend();
  assert.equal(time, 1000);
  scheduler.noteSent();
  await scheduler.beforeSend();
  assert.equal(time, 126000);
  assert.equal(checks, 1);
});

test('monitoring continues after the queue and can be stopped without further checks', async () => {
  let time = 0, stopped = false, checks = 0;
  const scheduler = createAutomation({ afterQueue: 'monitor', checkEverySeconds: 7 }, {
    now: () => time, sleep: async ms => { time += ms; }, isStopped: () => stopped, emit() {},
    checkInbox: async () => { checks++; stopped = true; return {}; },
  });
  await assert.rejects(scheduler.finish(), /automation_stopped/);
  assert.equal(checks, 1);
  assert.equal(time, 7000);
});

test('legacy minute intervals migrate to seconds and finish mode never waits for timed checks', async () => {
  assert.equal(normalizeAutomation({ checkEveryMinutes: 2 }).checkEverySeconds, 120);
  const scheduler = createAutomation({ afterQueue: 'finish', checkEverySeconds: 3 }, {
    isStopped: () => false, emit() {}, checkInbox: async () => { throw new Error('unexpected check'); },
    sleep: async () => { throw new Error('unexpected delay'); },
  });
  await scheduler.finish();
});

test('periodic snapshots use fresh run IDs, omit local metadata and preserve mailbox identity', async () => {
  const context = { pages: () => [{ isClosed: () => false, url: () => 'https://mail.google.com/mail/u/0/' }] };
  const snapshot = { mailbox_email: 'owner@example.com', entries: [], ignored_count: 0, pages: 1, scanned_at: new Date().toISOString(), moved_to_inbox: false };
  const uploads = [];
  const options = { profileId: '1', mailbox: 'owner@example.com', capture: async () => snapshot, api: async (_path, payload) => { uploads.push(payload); return { complete: true }; } };
  await checkCampaignInbox(context, options);
  await checkCampaignInbox(context, options);
  assert.notEqual(uploads[0].run_id, uploads[1].run_id);
  assert.equal(uploads[0].profile_id, '1');
  assert.equal(uploads[0].moved_to_inbox, undefined);
  await assert.rejects(checkCampaignInbox(context, { ...options, mailbox: 'other@example.com' }), /аккаунт изменился/);
  assert.equal(uploads.length, 2);
});

test('per-profile limit leaves unsent jobs untouched and runs no parallel inbox actions', async () => {
  let sends = 0, claims = 0, checks = 0, sending = false;
  const result = await runCampaign({ pages: () => [{ isClosed: () => false, url: () => 'https://mail.google.com/mail/u/0/' }] }, {
    runId: 'test', automation: { maxPerProfile: 2, checkEverySent: 1, checkEverySeconds: 0 },
    config: { workflowMode: 'funnel', subjectLines: 'Subject', serviceCode: 'Depop', templates: { Depop: 'Body' } },
  }, {
    profileId: '1', mailbox: 'owner@example.com', token: 'fake', html: '<p>Reply</p>', isStopped: () => false, emit() {},
    checkInboxImpl: async () => { assert.equal(sending, false); checks++; return {}; },
    fetchImpl: async url => {
      if (url.includes('/replies/candidates?')) return new Response(JSON.stringify({ items: [] }));
      if (url.endsWith('/prepare')) return new Response(JSON.stringify({ jobs: [1, 2, 3].map(id => ({ id, recipient: 'seller@example.com', ordinal: id - 1, ad: {}, status: 'pending' })) }));
      if (url.endsWith('/claim')) { claims++; return new Response(JSON.stringify({ status: 'sending' })); }
      return new Response(JSON.stringify({ status: 'sent' }));
    },
    sendImpl: async (_page, _job, _content, hooks) => { sending = true; sends++; await hooks.claim({}); sending = false; return { draft_ref: '#msg-a:test', thread_ref: '#thread-a:test' }; },
  });
  assert.deepEqual(result, { sent: 2, halted: false });
  assert.equal(sends, 2); assert.equal(claims, 2); assert.equal(checks, 2);
});

import { captureInboxWithRecovery } from './inbox.mjs';

test('transient inbox errors retry capture three times, with interruptible backoff', async () => {
  let captures = 0, reloads = 0, slept = 0;
  const page = { isClosed: () => false, url: () => 'https://mail.google.com/mail/u/0/#inbox', reload: async () => { reloads++; } };
  const snapshot = { mailbox_email: 'owner@example.com' };
  const options = { mailbox: 'owner@example.com', sleep: async ms => { slept += ms; }, capture: async () => {
    if (++captures < 3) throw Object.assign(new Error('Gmail not loaded'), { code: 'inbox_not_ready' });
    return snapshot;
  } };
  assert.equal(await captureInboxWithRecovery(page, options), snapshot);
  assert.equal(captures, 3); assert.equal(reloads, 2); assert.equal(slept, 7000);
  captures = 0;
  await assert.rejects(captureInboxWithRecovery(page, { ...options, capture: async () => { captures++; throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); } }), error => error.retryableInbox === true);
  assert.equal(captures, 3);
  captures = 0;
  await assert.rejects(captureInboxWithRecovery(page, { ...options, capture: async () => { captures++; return { mailbox_email: 'other@example.com' }; } }), /аккаунт изменился/);
  assert.equal(captures, 1);
  let stopped = false;
  await assert.rejects(captureInboxWithRecovery(page, { ...options, isStopped: () => stopped, capture: async () => { captures++; throw Object.assign(new Error('loading'), { code: 'inbox_not_ready' }); }, sleep: async () => { stopped = true; } }), /остановлена/);
});

test('monitoring skips exhausted transient capture but keeps its next scheduled check', async () => {
  let time = 0, checks = 0, stopped = false;
  const events = [];
  const scheduler = createAutomation({ afterQueue: 'monitor', checkEverySeconds: 2 }, {
    now: () => time, sleep: async ms => { time += ms; }, isStopped: () => stopped, emit: (...event) => events.push(event),
    checkInbox: async () => {
      if (++checks === 1) throw Object.assign(new Error('3 captures failed'), { retryableInbox: true });
      stopped = true; return {};
    },
  });
  await assert.rejects(scheduler.finish(), /automation_stopped/);
  assert.equal(checks, 2); assert.equal(time, 4000);
  assert.ok(events.some(event => event[0] === 'error' && event[1].includes('следующая — по расписанию')));
});

test('checks after 10 sends resume the queue; timed monitoring starts only after queue or limit', async () => {
  for (const [count, limit, mode, expected] of [[25, 30, 'monitor', 25], [25, 20, 'monitor', 20], [10, 30, 'monitor', 10], [25, 30, 'finish', 25]]) {
    let sent = 0, time = 0, stopped = false;
    const checks = [], events = [];
    const result = await runCampaign({ pages: () => [{ isClosed: () => false, url: () => 'https://mail.google.com/mail/u/0/' }] }, {
      runId: 'test', automation: { maxPerProfile: limit, checkEverySent: 10, checkEverySeconds: 2, afterQueue: mode, delayMinSeconds: 3, delayMaxSeconds: 3 },
      config: { workflowMode: 'funnel', subjectLines: 'Subject', serviceCode: 'Depop', templates: { Depop: 'Body' } },
    }, {
      profileId: '1', mailbox: 'owner@example.com', token: 'fake', html: '<p>Reply</p>', isStopped: () => stopped,
      emit: (_level, message) => events.push(message),
      automationClock: { now: () => time, sleep: async ms => { time += ms; } },
      checkInboxImpl: async () => { checks.push(sent); if (events.some(message => message.includes('каждые 2 сек.'))) stopped = true; return {}; },
      fetchImpl: async (url, init) => {
        if (url.includes('/replies/candidates?')) return new Response(JSON.stringify({ items: [] }));
        if (url.endsWith('/prepare')) return new Response(JSON.stringify({ jobs: Array.from({ length: count }, (_, i) => ({ id: i + 1, ordinal: i, recipient: 'seller@example.com', ad: {}, status: 'pending' })) }));
        if (url.endsWith('/claim')) return new Response(JSON.stringify({ status: 'sending' }));
        return new Response(JSON.stringify({ status: JSON.parse(init.body).status }));
      },
      sendImpl: async (_page, _job, _body, hooks) => { await hooks.claim({}); sent++; return { draft_ref: '#msg-a:test', thread_ref: '#thread-a:test' }; },
    });
    assert.equal(result.sent, expected);
    assert.deepEqual(checks, [...Array.from({ length: Math.floor(expected / 10) }, (_, i) => (i + 1) * 10), ...(mode === 'monitor' ? [expected] : [])]);
    assert.ok(events.some(message => message.includes(expected >= limit ? 'достигнут лимит профиля' : 'очередь исчерпана')));
    assert.equal(events.some(message => message.includes('каждые 2 сек.')), mode === 'monitor');
  }
});
