import test from 'node:test';
import assert from 'node:assert/strict';
import { macosTarget } from './prepare-macos.mjs';

test('macOS packages cannot mix processor architectures or build on Windows', () => {
  assert.equal(macosTarget('darwin', 'arm64'), 'aarch64-apple-darwin');
  assert.equal(macosTarget('darwin', 'x64'), 'x86_64-apple-darwin');
  assert.throws(() => macosTarget('win32', 'x64'), /Mac/);
  assert.throws(() => macosTarget('darwin', 'x64', undefined, true), /Rosetta/);
  assert.throws(() => macosTarget('darwin', 'arm64', 'x86_64-apple-darwin'), /архитектуры/);
  assert.throws(() => macosTarget('darwin', 'x64', 'universal-apple-darwin'), /архитектуры/);
});
