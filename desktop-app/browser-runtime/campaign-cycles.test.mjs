import test from 'node:test';
import assert from 'node:assert/strict';
import { cycleQuotas, runCampaignCycles } from './campaign-cycles.mjs';

async function scenario({ count = 5, limit = 25, shortFirst, emptyNext = false, monitor = false, uncertain = false, interval = 10, uncertainAt = 1, batchAvailable = Infinity, failProfile } = {}) {
  let time = 0, serial = 0;
  const requests = [], sequence = [], batches = new Map(), sends = new Set();
  const automation = { maxPerProfile: limit, checkEverySent: interval, checkEverySeconds: 2,
    afterQueue: monitor ? 'monitor' : 'finish', delayMinSeconds: 3, delayMaxSeconds: 3, pauseEverySent: 12, pauseSeconds: 4 };
  const profiles = Array.from({ length: count }, (_, i) => {
    const p = { id: String(i + 1), closed: false, failed: false, events: [], checks: 0, timed: 0, reloads: 0, mailbox: `owner${i + 1}@example.com` };
    p.context = { pages: () => [{ isClosed: () => false, url: () => 'https://mail.google.com/mail/u/0/', reload: async () => { p.reloads++; }, waitForFunction: async () => {}, evaluate: async () => p.mailbox, locator: () => ({ filter() { return this; }, count: async () => 0 }) }] };
    p.isStopped = () => p.closed || p.timed > 0;
    p.emit = (_level, message, extra) => { p.events.push(message); if (extra?.phase === 'monitoring' && message.includes('проверяем входящие')) p.timed++; };
    p.finish = async (sent, failed) => { p.closed = true; p.final = { sent, failed }; };
    p.hooks = {
      automationClock: { now: () => time, sleep: async ms => { time += ms; } },
      checkInboxImpl: async () => { p.checks++; sequence.push(`check:${p.id}:${p.state.sent}`); return {}; },
      sendImpl: async (_page, job, _body, hooks) => {
        assert.equal(sends.has(job.id), false); sends.add(job.id);
        if (p.id === failProfile) {
          const { SendError } = await import('./sender.mjs');
          throw new SendError('compose_selector', 'Compose unavailable');
        }
        await hooks.claim({});
        if (uncertain && job.id === uncertainAt) {
          const { SendError } = await import('./sender.mjs');
          throw new SendError('send_unconfirmed', 'No confirmation', true);
        }
        return { draft_ref: '#msg-a:test', thread_ref: '#thread-a:test' };
      },
    };
    return p;
  });
  const makeBatch = (id, quotas, available = Infinity, order = Object.keys(quotas)) => {
    const groups = order.map(profile_id => ({ profile_id, ads: [] }));
    let left = Math.min(available, Object.values(quotas).reduce((a, b) => a + b, 0));
    while (left) for (const g of groups) if (left && g.ads.length < quotas[g.profile_id]) { g.ads.push({ id: ++serial }); left--; }
    const batch = { run_id: id, parent_run_id: id === 'root' ? null : 'root', received: groups.reduce((n, g) => n + g.ads.length, 0), batches: groups };
    batches.set(id, batch); return batch;
  };
  const first = makeBatch('root', Object.fromEntries(profiles.map(p => [p.id, Math.min(10, limit)])), shortFirst);
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : {};
    if (url.endsWith('/parser/batch')) {
      requests.push(body); sequence.push('parser');
      for (const p of profiles.filter(p => interval && body.profile_ids.includes(p.id))) assert.ok(p.checks > requests.length - 1, 'each participating profile checked inbox before next parser call');
      return Response.json(makeBatch(body.run_id, body.profile_limits, emptyNext ? 0 : batchAvailable, body.profile_ids));
    }
    if (url.endsWith('/outbound/prepare')) {
      assert.equal(body.run_id, 'root');
      const ads = batches.get(body.batch_run_id).batches.find(g => g.profile_id === body.profile_id).ads;
      return Response.json({ jobs: ads.map((ad, ordinal) => ({ id: ad.id, ordinal, ad: {}, recipient: `u${ad.id}@example.com`, status: 'pending' })) });
    }
    if (url.endsWith('/claim')) return Response.json({ status: 'sending' });
    if (url.endsWith('/finish')) return Response.json({ status: body.status });
    if (url.includes('/replies/candidates?')) return Response.json({ items: [] });
    throw new Error(`Unexpected API ${url}`);
  };
  profiles.forEach(p => p.hooks.fetchImpl = fetchImpl);
  await runCampaignCycles({ runId: 'root', config: { workflowMode: 'funnel', subjectLines: 'Subject', serviceCode: 'Depop', templates: { Depop: 'Body' } } }, {
    automation, parserBatch: first, parserRequest: { platform: 'depop', api_key: 'fake' }, token: 'fake', html: '<p>Reply</p>',
    mailboxes: Object.fromEntries(profiles.map(p => [p.id, p.mailbox])),
  }, profiles, { fetchImpl, now: () => time, sleep: async ms => { time += ms; } });
  return { profiles, requests, sends, sequence };
}

test('five profiles send 10 + 10 + 5; next batch waits for all inbox checks; counters span cycles', async () => {
  const { profiles, requests, sends } = await scenario();
  assert.equal(sends.size, 125);
  assert.deepEqual(requests.map(r => Object.values(r.profile_limits).reduce((a, b) => a + b, 0)), [50, 25]);
  assert.notEqual(requests[0].run_id, requests[1].run_id);
  assert.ok(profiles.every(p => p.final.sent === 25 && !p.final.failed && p.checks === 3 && p.timed === 0));
});

test('short batches remain balanced and remaining quotas vary by actual per-profile progress', async () => {
  const { profiles, requests } = await scenario({ shortFirst: 8, limit: 12 });
  assert.deepEqual(Object.values(requests[0].profile_limits), [10, 10, 10, 10, 10]);
  assert.deepEqual(requests[1].profile_ids, ['4', '5']);
  assert.deepEqual(requests[1].profile_limits, { 4: 1, 5: 1 });
  assert.ok(profiles.every(p => p.final.sent === 12 && !p.final.failed));
});

test('empty parser result ends cycling; monitor is used only when explicitly enabled', async () => {
  for (const monitor of [false, true]) {
    const { profiles, requests } = await scenario({ count: 2, emptyNext: true, monitor });
    assert.equal(requests.length, 1);
    assert.ok(profiles.every(p => p.final.sent === 10 && !p.final.failed && p.timed === Number(monitor)));
  }
});

test('empty initial batch also enters configured monitoring without requesting another batch', async () => {
  const { profiles, requests } = await scenario({ count: 1, shortFirst: 0, monitor: true });
  assert.equal(requests.length, 0);
  assert.equal(profiles[0].timed, 1);
  assert.equal(profiles[0].final.sent, 0);
});

test('uncertain sends consume the run limit across cycles and are not retried', async () => {
  const { profiles, sends } = await scenario({ count: 1, limit: 12, uncertain: true });
  assert.equal(sends.size, 12);
  assert.equal(profiles[0].state.uncertain, 1);
  assert.equal(profiles[0].final.sent, 11);
});

test('fresh run resets totals, excludes failed/stopped/limited profiles from quotas', async () => {
  const profile = (id, sent, uncertain, failed, stopped) => ({ id, state: { sent, uncertain }, failed, isStopped: () => stopped });
  assert.deepEqual(cycleQuotas([profile('1', 20, 2), profile('2', 25, 0), profile('3', 0, 0, true), profile('4', 0, 0, false, true)], { checkEverySent: 10, maxPerProfile: 25 }), { 1: 3 });
  for (let run = 0; run < 2; run++) assert.equal((await scenario({ count: 1, limit: 2 })).profiles[0].final.sent, 2);
});

test('stop aborts an in-flight shared parser request and finalizes profiles', async () => {
  const controller = new AbortController();
  let closed = false, time = 0, requested = false;
  const p = { id: '1', context: {}, isStopped: () => controller.signal.aborted, emit() {}, finish: async () => { closed = true; } };
  await runCampaignCycles({ runId: 'root' }, {
    automation: { maxPerProfile: 20, checkEverySent: 10 }, token: 'fake', mailboxes: { 1: 'owner@example.com' },
    parserRequest: {}, parserBatch: { run_id: 'root', received: 10, batches: [{ profile_id: '1', ads: Array(10).fill({}) }] },
  }, [p], {
    signal: controller.signal, isStopped: () => controller.signal.aborted,
    now: () => time, sleep: async ms => { time += ms; },
    sendCycle: async (_context, _run, hooks) => { hooks.campaignState.sent = 10; return { sent: 10, halted: false }; },
    fetchImpl: async (_url, init) => {
      requested = true;
      const pending = new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      controller.abort();
      return pending;
    },
  });
  assert.equal(requested, true);
  assert.equal(closed, true);
  assert.equal(p.state.sent, 10);
});


test('disabled send-count checks still recover uncertain drafts before the next batch', async () => {
  const { profiles, requests, sends } = await scenario({ count: 1, limit: 12, uncertain: true, interval: 0, uncertainAt: 10 });
  assert.equal(requests.length, 1);
  assert.equal(sends.size, 12);
  assert.equal(profiles[0].checks, 0);
  assert.equal(profiles[0].reloads, 1);
  assert.equal(profiles[0].final.sent, 11);
});


test('repeated tiny batches prioritize profiles with fewer total sends', async () => {
  const { profiles, requests } = await scenario({ count: 3, limit: 2, shortFirst: 1, batchAvailable: 1 });
  assert.deepEqual(requests[0].profile_ids, ['2', '3', '1']);
  assert.deepEqual(requests[1].profile_ids, ['3', '1', '2']);
  assert.ok(profiles.every(p => p.final.sent === 2));
});


test('a failed profile is excluded from subsequent requests while healthy profiles reach their limit', async () => {
  const { profiles, requests } = await scenario({ count: 3, limit: 12, failProfile: '1' });
  assert.equal(profiles[0].final.failed, true);
  assert.equal(profiles[0].final.sent, 0);
  assert.deepEqual(requests[0].profile_ids, ['2', '3']);
  assert.deepEqual(requests[0].profile_limits, { 2: 2, 3: 2 });
  assert.ok(profiles.slice(1).every(p => p.final.sent === 12 && !p.final.failed));
});

test('20 concurrent profile cycles reach a barrier before one shared parser request', async () => {
  let release, entered, active = 0, requests = 0, completed = 0, time = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  const profiles = Array.from({ length: 20 }, (_, i) => ({ id: String(i + 1), isStopped: () => false, emit() {}, finish: async () => {} }));
  const running = runCampaignCycles({ runId: 'root' }, {
    automation: { maxPerProfile: 20, checkEverySent: 10 }, token: 'fake',
    mailboxes: Object.fromEntries(profiles.map(p => [p.id, `${p.id}@example.com`])), parserRequest: {},
    parserBatch: { run_id: 'root', received: 200, batches: profiles.map(p => ({ profile_id: p.id, ads: Array(10).fill({}) })) },
  }, profiles, {
    now: () => time, sleep: async ms => { time += ms; },
    sendCycle: async (_context, _run, hooks) => {
      if (!hooks.campaignState.sent) {
        if (++active === 20) entered();
        await gate;
        active--; completed++;
      }
      hooks.campaignState.sent += 10;
      return { sent: hooks.campaignState.sent, halted: false };
    },
    fetchImpl: async (_url, init) => {
      requests++;
      assert.equal(completed, 20);
      assert.equal(active, 0);
      const payload = JSON.parse(init.body);
      assert.equal(Object.values(payload.profile_limits).reduce((a, b) => a + b, 0), 200);
      return Response.json({ run_id: payload.run_id, parent_run_id: 'root', received: 200,
        batches: profiles.map(p => ({ profile_id: p.id, ads: Array(10).fill({}) })) });
    },
  });
  await ready;
  assert.equal(active, 20);
  assert.equal(requests, 0);
  release(); await running;
  assert.equal(requests, 1);
  assert.ok(profiles.every(p => p.state.sent === 20 && !p.failed));
});

test('a profile closed during shared cooldown is removed before requesting ads', async () => {
  let time = 0, closed = false, requests = 0;
  const profiles = ['1', '2'].map(id => ({ id, isStopped: () => id === '1' && closed, emit() {}, finish: async () => {} }));
  await runCampaignCycles({ runId: 'root' }, {
    automation: { maxPerProfile: 20, checkEverySent: 10 }, token: 'fake', parserRequest: {},
    mailboxes: { 1: 'one@example.com', 2: 'two@example.com' },
    parserBatch: { run_id: 'root', received: 20, batches: profiles.map(p => ({ profile_id: p.id, ads: Array(10).fill({}) })) },
  }, profiles, {
    now: () => time, sleep: async ms => { time += ms; closed = true; },
    sendCycle: async (_context, _run, hooks) => { hooks.campaignState.sent += 10; return { sent: hooks.campaignState.sent, halted: false }; },
    fetchImpl: async (_url, init) => {
      requests++;
      const payload = JSON.parse(init.body);
      assert.deepEqual(payload.profile_ids, ['2']);
      assert.deepEqual(payload.profile_limits, { 2: 10 });
      return Response.json({ run_id: payload.run_id, parent_run_id: 'root', received: 10, batches: [{ profile_id: '2', ads: Array(10).fill({}) }] });
    },
  });
  assert.equal(requests, 1);
  assert.equal(profiles[0].state.sent, 10);
  assert.equal(profiles[1].state.sent, 20);
});

test('duplicate Gmail accounts are rejected before any sending or parser calls', async () => {
  let finished = 0;
  const profiles = ['1', '2'].map(id => ({ id, isStopped: () => false, emit() {}, finish: async () => { finished++; } }));
  await runCampaignCycles({ runId: 'root' }, {
    mailboxes: { 1: 'ME@example.com', 2: ' me@example.com ' }, parserBatch: {},
  }, profiles, { sendCycle: async () => { assert.fail('duplicate mailbox sent'); }, fetchImpl: async () => { assert.fail('duplicate mailbox requested parser'); } });
  assert.equal(finished, 2);
  assert.ok(profiles.every(p => p.failed));
});
