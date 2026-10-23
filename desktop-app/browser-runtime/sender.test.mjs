import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { prepareRendering, renderJob, renderVariables, sendOne, runCampaign, SendError, insertRenderedHtml, insertHtml, typeMessage, sendWithRecovery } from './sender.mjs';

test('selector recovery reloads the same mailbox once and never retries reserved sends', async () => {
  const navigations = [];
  const page = { url: () => 'https://mail.google.com/mail/u/2/#inbox', isClosed: () => false, goto: async url => { navigations.push(url); }, waitForFunction: async () => {} };
  const hooks = { isStopped: () => false, claim: async () => {} };
  let attempts = 0;
  const result = await sendWithRecovery(page, {}, {}, hooks, async () => {
    if (++attempts === 1) throw new SendError('dialog_selector', 'Не найден селектор окна письма.');
    return { ok: true };
  });
  assert.equal(result.ok, true);
  assert.equal(attempts, 2);
  assert.deepEqual(navigations, ['about:blank', 'https://mail.google.com/mail/u/2/#inbox']);
  navigations.length = 0; attempts = 0;
  await assert.rejects(sendWithRecovery(page, {}, {}, hooks, async () => { attempts++; throw new SendError('dialog_selector', 'missing'); }));
  assert.equal(attempts, 2);
  assert.equal(navigations.length, 2);
  navigations.length = 0;
  await assert.rejects(sendWithRecovery(page, {}, {}, hooks, async (_page, _job, _content, guarded) => { await guarded.claim({}); throw new SendError('dialog_selector', 'missing'); }));
  assert.equal(navigations.length, 0);
  await assert.rejects(sendWithRecovery(page, {}, {}, hooks, async () => { throw new SendError('send_unconfirmed', 'unknown', true); }));
  assert.equal(navigations.length, 0);
});

test('subjects and funnel lines rotate independently and substitutions do not recurse', () => {
  const rendering = prepareRendering({ workflowMode: 'funnel', serviceCode: 'Depop', subjectLines: 'About {item}\n\nPrice {price}', templates: { Depop: 'Hi {name}\nItem {item}\nCost {price}' } });
  const ad = { title: '{name}', seller: 'Alice', price: '25' };
  assert.deepEqual(renderJob(rendering, { ordinal: 3, ad }), { subject: 'Price 25', body: 'Hi Alice', html: false });
  assert.equal(renderVariables('{item} {name} {price} {link}', ad, true), '{name} Alice 25 {link}');
  assert.equal(renderVariables('{item}', { title: '<b>&"' }, true), '&lt;b&gt;&amp;&quot;');
  assert.throws(() => prepareRendering({ workflowMode: 'funnel', templates: {} }), /темы/);
});

const encode = value => Buffer.from(JSON.stringify([value])).toString('base64');
const expected = { draft_ref: '#msg-a:r123', thread_ref: '#thread-a:r456' };
const job = { id: 1, recipient: 'seller@example.com', ordinal: 0, ad: { title: 'Item', seller: 'Seller', price: '10' } };
const toast = (thread, draft) => `<div class="vh"><span>Envoyé</span><span id="link_undo" jslog="11:${encode(draft)}"></span><span id="link_vsm" param="${thread}">Voir</span></div>`;

async function fixture(options = {}) {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  const dialog = `<div id="draftDialog" role="dialog"><input peoplekit-id="test" role="combobox"><div id="recipientChip"></div><input name="subjectbox"><input type="hidden" name="draft" value="${expected.draft_ref}"><div contenteditable="true" role="textbox" g_editable="true"></div>${options.noSend ? '' : `<div class="aoO" role="button" tabindex="0" jslog="1:${encode(expected.thread_ref)}">Senden</div>`}</div>`;
  const html = `<a href="https://accounts.google.com/SignOutOptions" aria-label="Google Account: User (owner@example.com)"></a>${options.stale ? toast(expected.thread_ref, expected.draft_ref) : ''}${options.noCompose ? '' : '<div gh="cm" role="button" tabindex="0">Rédiger</div>'}<script>
    window.clicks = 0;
    const compose = document.querySelector('[gh="cm"]');
    if (compose) compose.onclick = () => {
      document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(dialog)});
      const root = document.getElementById('draftDialog');
      root.querySelector('[role="combobox"]').addEventListener('keydown', event => {
        if (event.key === 'Enter') {
          const chip = document.getElementById('recipientChip');
          chip.setAttribute('email', event.target.value);
          event.target.value = '';
          event.preventDefault();
        }
      });
      const send = root.querySelector('.aoO');
      if (send) send.onclick = () => {
        window.clicks++;
        window.sentSubject = root.querySelector('[name="subjectbox"]').value;
        window.sentBody = root.querySelector('[contenteditable]').innerHTML;
        root.remove();
        ${options.noToast ? '' : `setTimeout(() => document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(toast(options.wrongThread ? '#thread-a:wrong' : expected.thread_ref, options.wrongDraft ? '#msg-a:wrong' : expected.draft_ref))}), 10);`}
      };
    };
  </script>`;
  // No request in these tests reaches Google or a recipient.
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('https://mail.google.com/mail/u/0/#inbox');
  return { browser, page };
}

test('localized compose/send labels work and only the current notification confirms sending', async () => {
  const { browser, page } = await fixture();
  try {
    let claims = 0;
    const proof = await sendOne(page, job, { subject: 'About Item', body: 'Hello\nSeller', html: false }, {
      mailbox: 'owner@example.com', claim: async metadata => { claims++; assert.equal(metadata.draft_ref, expected.draft_ref); assert.equal(metadata.body_hash.length, 64); }, selectorTimeout: 1000, confirmTimeout: 1000,
    });
    assert.deepEqual(proof, expected);
    assert.equal(claims, 1);
    assert.equal(await page.evaluate(() => window.clicks), 1);
    assert.equal(await page.evaluate(() => window.sentSubject), 'About Item');
  } finally { await browser.close(); }
});

test('HTML is rendered, stylesheet rules are inlined, and scripts/event handlers are removed', async () => {
  const { browser, page } = await fixture();
  try {
    await sendOne(page, job, { subject: 'HTML', body: '<html><head><style>.greeting{color:rgb(255,0,0);font-weight:700}</style></head><body><p class="greeting" onclick="window.bad=1">Hello <b>Seller</b></p><script>window.bad=1</script></body></html>', html: true }, {
      mailbox: 'owner@example.com', claim: async () => {}, selectorTimeout: 2000, confirmTimeout: 1000,
    });
    const body = await page.evaluate(() => window.sentBody);
    assert.match(body, /<b>Seller<\/b>/);
    assert.match(body, /color: rgb\(255, 0, 0\)/);
    assert.doesNotMatch(body, /<script|onclick=|<style/);
    assert.equal(await page.evaluate(() => window.bad), undefined);
  } finally { await browser.close(); }
});

test('HTML replaces existing editor contents with Gmail-style Trusted Types enforcement', async () => {
  const { browser, page } = await fixture();
  try {
    await page.locator('[gh="cm"]').click();
    const body = page.locator('[contenteditable="true"]');
    await body.fill('312');
    await page.evaluate(() => {
      const policy = document.createElement('meta');
      policy.httpEquiv = 'Content-Security-Policy';
      policy.content = "require-trusted-types-for 'script'; trusted-types 'none'";
      document.head.append(policy);
    });
    await assert.rejects(body.evaluate(insertHtml, '<p>Test</p>'), /TrustedHTML/);
    await insertRenderedHtml(page, body, '<style>p{color:rgb(255,0,0)}</style><p>Hello <b>Seller</b></p>');
    assert.equal(await body.innerText(), 'Hello Seller');
    assert.match(await body.innerHTML(), /color: rgb\(255, 0, 0\)/);
    assert.doesNotMatch(await body.innerHTML(), /312|<style/);
    assert.equal(await body.getAttribute('data-luxury-editor'), null);
  } finally { await browser.close(); }
});

test('paced text input preserves unicode and paragraphs, and stops immediately on cancellation or lost focus', async () => {
  const { browser, page } = await fixture();
  try {
    await page.locator('[gh="cm"]').click();
    const body = page.locator('[contenteditable="true"]');
    const text = 'Привет, Seller! 👋\n\nЦена: 25 €.';
    const pauses = [];
    await typeMessage(body, text, { random: () => 0.5, sleep: async ms => { pauses.push(ms); } });
    assert.equal(await body.innerText(), text);
    assert.ok(pauses.length > [...text].length);
    let stopped = false;
    await assert.rejects(typeMessage(body, 'Testing cancellation', { isStopped: () => stopped, sleep: async () => { stopped = true; } }), error => error.code === 'stopped');
    assert.equal(await body.innerText(), 'T');
    await assert.rejects(typeMessage(body, 'Focus', { sleep: async () => { await page.locator('input[name="subjectbox"]').focus(); } }), error => error.code === 'body_focus_lost');
    assert.equal(await body.innerText(), 'F');
    assert.equal(await page.evaluate(() => window.clicks), 0);
  } finally { await browser.close(); }
});

test('old toast, another thread and another message never count as a successful send', async () => {
  for (const options of [{ stale: true, noToast: true }, { wrongThread: true }, { wrongDraft: true }]) {
    const { browser, page } = await fixture(options);
    try {
      await assert.rejects(sendOne(page, job, { subject: 'Test', body: 'Body', html: false }, { mailbox: 'owner@example.com', claim: async () => {}, selectorTimeout: 500, confirmTimeout: 150 }), error => error.code === 'send_unconfirmed' && error.unknown === true);
      assert.equal(await page.evaluate(() => window.clicks), 1);
    } finally { await browser.close(); }
  }
});

test('a missing compose/send selector fails before claiming a send', async () => {
  for (const [options, code] of [[{ noCompose: true }, 'compose_selector'], [{ noSend: true }, 'send_selector']]) {
    const { browser, page } = await fixture(options);
    try {
      let claimed = false;
      await assert.rejects(sendOne(page, job, { subject: 'Test', body: 'Body', html: false }, { mailbox: 'owner@example.com', claim: async () => { claimed = true; }, selectorTimeout: 150 }), error => error.code === code && error.message.includes('Не найден селектор'));
      assert.equal(claimed, false);
      assert.equal(await page.evaluate(() => window.clicks), 0);
    } finally { await browser.close(); }
  }
});

test('switching the mailbox during the reservation prevents any click', async () => {
  const { browser, page } = await fixture();
  try {
    await assert.rejects(sendOne(page, job, { subject: 'Test', body: 'Body', html: false }, {
      mailbox: 'owner@example.com', selectorTimeout: 1000,
      claim: async () => page.evaluate(() => document.querySelector('a').setAttribute('aria-label', 'other@example.com')),
    }), error => error.code === 'compose_changed' && error.unknown);
    assert.equal(await page.evaluate(() => window.clicks), 0);
  } finally { await browser.close(); }
});

test('campaign confirms DB success and leaves uncertain sends without repeating them', async () => {
  const config = { workflowMode: 'funnel', subjectLines: 'Question {item}', serviceCode: 'Depop', templates: { Depop: 'Hi {name}' } };
  for (const fail of [false, true]) {
    const calls = [];
    const events = [];
    const response = await runCampaign({ pages: () => [{ isClosed: () => false, url: () => 'https://mail.google.com/mail/u/0/' }] }, { runId: 'run', config }, {
      profileId: '1', mailbox: 'owner@example.com', token: 'not-a-real-token', html: '', isStopped: () => false,
      emit: (...event) => events.push(event),
      fetchImpl: async (url, init) => {
        calls.push([url, JSON.parse(init.body)]);
        return new Response(JSON.stringify(url.endsWith('/prepare') ? { jobs: [{ ...job, status: 'pending' }] } : { status: url.endsWith('/claim') ? 'sending' : fail ? 'unknown' : 'sent' }), { status: 200 });
      },
      sendImpl: async (_page, _job, _content, hooks) => {
        await hooks.claim({ ...expected, subject_hash: 'a'.repeat(64), body_hash: 'b'.repeat(64) });
        if (fail) throw new SendError('send_unconfirmed', 'No confirmation', true);
        return expected;
      },
    });
    assert.equal(response.sent, fail ? 0 : 1);
    assert.equal(response.halted, false);
    assert.equal(events.filter(event => event[0] === 'success').length, fail ? 0 : 1);
    assert.equal(calls.at(-1)[1].status, fail ? 'unknown' : 'sent');
    assert.ok(events.some(event => event[0] === (fail ? 'error' : 'info')));
  }
});

test('lost DB acknowledgements retry only the same receipt, never the Send action', async () => {
  for (const recover of [true, false]) {
    let sends = 0;
    let receipts = 0;
    const receiptBodies = [];
    const result = await runCampaign({ pages: () => [{ isClosed: () => false, url: () => 'https://mail.google.com/mail/u/0/' }] }, {
      runId: 'run', config: { workflowMode: 'funnel', subjectLines: 'Subject', serviceCode: 'Depop', templates: { Depop: 'Body' } },
    }, {
      profileId: '1', mailbox: 'owner@example.com', token: 'fake', isStopped: () => false, emit() {},
      fetchImpl: async (url, init) => {
        if (url.endsWith('/prepare')) return new Response(JSON.stringify({ jobs: [{ ...job, status: 'pending' }] }));
        if (url.endsWith('/claim')) return new Response(JSON.stringify({ status: 'sending' }));
        receipts++;
        receiptBodies.push(JSON.parse(init.body));
        if (!recover || receipts < 3) throw new Error('network unavailable');
        return new Response(JSON.stringify({ status: 'sent' }));
      },
      sendImpl: async (_page, _job, _content, hooks) => {
        sends++;
        await hooks.claim({ ...expected, subject_hash: 'a'.repeat(64), body_hash: 'b'.repeat(64) });
        return expected;
      },
    });
    assert.equal(sends, 1);
    assert.equal(receipts, 3);
    assert.ok(receiptBodies.every(body => body.status === 'sent' && JSON.stringify(body) === JSON.stringify(receiptBodies[0])));
    assert.equal(result.sent, recover ? 1 : 0);
    assert.equal(result.halted, !recover);
  }
});

test('unknown sends advance to the next job once, preserve pacing and never count as confirmed sent', async () => {
  for (const scenario of ['continue', 'lost-outcome', 'mailbox-changed', 'limit']) {
    let reloads = 0, time = 0;
    const sends = [], finishes = [], events = [];
    const page = { isClosed: () => false, url: () => 'https://mail.google.com/mail/u/0/#inbox', reload: async () => { reloads++; }, waitForFunction: async () => {}, evaluate: async () => scenario === 'mailbox-changed' ? 'other@example.com' : 'owner@example.com', locator: () => ({ filter() { return this; }, count: async () => 0 }) };
    const result = await runCampaign({ pages: () => [page] }, {
      runId: 'run', config: { workflowMode: 'funnel', subjectLines: 'Subject', serviceCode: 'Depop', templates: { Depop: 'Body' } },
      automation: { delayMinSeconds: 2, delayMaxSeconds: 2, checkEverySent: 0, maxPerProfile: scenario === 'limit' ? 1 : 0, afterQueue: 'finish' },
    }, {
      profileId: '1', mailbox: 'owner@example.com', token: 'fake', isStopped: () => false, emit: (...event) => events.push(event),
      automationClock: { now: () => time, sleep: async ms => { time += ms; } },
      fetchImpl: async (url, init) => {
        if (url.endsWith('/prepare')) return new Response(JSON.stringify({ jobs: [1, 2].map(id => ({ ...job, id, status: 'pending' })) }));
        if (url.endsWith('/claim')) return new Response(JSON.stringify({ status: 'sending' }));
        const body = JSON.parse(init.body); finishes.push(body.status);
        if (scenario === 'lost-outcome' && body.status === 'unknown') throw new Error('network unavailable');
        return new Response(JSON.stringify({ status: body.status }));
      },
      sendImpl: async (_page, current, _body, hooks) => {
        sends.push(current.id);
        await hooks.claim(expected);
        if (current.id === 1) throw new SendError('send_unconfirmed', 'No confirmation', true);
        assert.ok(time >= 2000);
        return expected;
      },
    });
    assert.equal(sends.filter(id => id === 1).length, 1);
    if (scenario === 'continue') {
      assert.deepEqual(sends, [1, 2]); assert.deepEqual(finishes, ['unknown', 'sent']);
      assert.deepEqual(result, { sent: 1, halted: false }); assert.equal(reloads, 1);
    } else if (scenario === 'limit') {
      assert.deepEqual(sends, [1]); assert.equal(result.sent, 0); assert.equal(result.halted, false);
    } else {
      assert.deepEqual(sends, [1]); assert.equal(result.halted, true);
    }
  }
});
