import test from 'node:test';
import assert from 'node:assert/strict';
import { macosTarget, verifyMacArchitecture } from './prepare-macos.mjs';

test('macOS packages cannot mix processor architectures or build on Windows', () => {
  assert.equal(macosTarget('darwin', 'arm64'), 'aarch64-apple-darwin');
  assert.equal(macosTarget('darwin', 'x64'), 'x86_64-apple-darwin');
  assert.throws(() => macosTarget('win32', 'x64'), /Mac/);
  assert.throws(() => macosTarget('darwin', 'x64', undefined, true), /Rosetta/);
  assert.throws(() => macosTarget('darwin', 'arm64', 'x86_64-apple-darwin'), /архитектуры/);
  assert.throws(() => macosTarget('darwin', 'x64', 'universal-apple-darwin'), /архитектуры/);
});


test('lipo receives the input file before the variable-length architecture list', () => {
  for (const architecture of ['arm64', 'x86_64']) {
    for (const binary of ['/Applications/Luxury Mailer.app/Contents/Resources/macos-runtime/bin/node', '/tmp/Chromium.app/Contents/MacOS/Chromium', '/tmp/bin/luxury-link']) {
      let calls = 0;
      verifyMacArchitecture(binary, architecture, (command, args) => {
        calls++;
        assert.equal(command, '/usr/bin/lipo');
        assert.equal(args[0], binary);
        const commandIndex = args.indexOf('-verify_arch');
        assert.ok(commandIndex > 0);
        assert.deepEqual(args.slice(commandIndex + 1), [architecture]);
      });
      assert.equal(calls, 1);
    }
  }
  assert.throws(() => verifyMacArchitecture('/tmp/node', 'x64'), /Unsupported/);
});
