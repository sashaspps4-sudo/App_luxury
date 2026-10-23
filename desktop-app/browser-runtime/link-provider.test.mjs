import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateReservedLink } from './link-provider.mjs';

const options = { kind: 'reply', jobId: 1, profileId: '1', mailbox: 'a@test.io' };
test('cached links never invoke provider; only persistence is retried', async () => {
  let calls = 0, saves = 0;
  const generate = async () => { calls++; return 'https://example.test/item'; };
  const api = async (_path, payload) => {
    if (!payload.link) return { status: 'reserved', claim_token: 'token' };
    if (++saves === 1) throw new Error('lost response');
    return { status: 'ready', link: payload.link };
  };
  assert.equal(await generateReservedLink({}, {}, { ...options, api, generate }), 'https://example.test/item');
  assert.equal(calls, 1); assert.equal(saves, 2);
  await generateReservedLink({}, {}, { ...options, generate, api: async () => ({ status: 'ready', link: 'https://example.test/cached' }) });
  assert.equal(calls, 1);
});

test('unknown reservation or provider result is never automatically retried', async () => {
  let calls = 0;
  const generate = async () => { calls++; throw new Error('provider timeout'); };
  await assert.rejects(generateReservedLink({}, {}, { ...options, generate, api: async () => { throw new Error('reservation timeout'); } }));
  assert.equal(calls, 0);
  await assert.rejects(generateReservedLink({}, {}, { ...options, generate, api: async () => ({ status: 'reserved', claim_token: 'token' }) }));
  assert.equal(calls, 1);
});

test('cache fingerprint ignores mail presentation and object key order', async () => {
  const fingerprints = [];
  const api = async (_p, payload) => { fingerprints.push(payload.fingerprint); return { status: 'ready', link: 'https://example.test/saved' }; };
  await generateReservedLink({ provider: 'eql', apiKey: 'secret', subjectLines: 'A' }, { price: 1, title: 'Item' }, { ...options, api });
  await generateReservedLink({ subjectLines: 'B', apiKey: 'secret', provider: 'eql' }, { title: 'Item', price: 1 }, { ...options, api });
  assert.equal(fingerprints[0], fingerprints[1]);
});

import { linkInvocation } from './link-provider.mjs';
test('packaged provider does not depend on system Python or source checkout', () => {
  assert.deepEqual(linkInvocation('darwin', { LUXURY_LINK_EXECUTABLE: '/Applications/Luxury Mailer.app/Contents/Resources/macos-runtime/bin/luxury-link' }), { executable: '/Applications/Luxury Mailer.app/Contents/Resources/macos-runtime/bin/luxury-link', args: [] });
  assert.equal(linkInvocation('darwin', {}).executable, 'python3');
  assert.equal(linkInvocation('win32', {}).executable, 'python');
  assert.equal(linkInvocation('darwin', { LUXURY_PYTHON: '/my/python' }).executable, '/my/python');
});
