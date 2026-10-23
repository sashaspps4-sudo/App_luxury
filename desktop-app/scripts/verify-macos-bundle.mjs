import { access, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { constants } from 'node:fs';
import { macosTarget } from './prepare-macos.mjs';

macosTarget();
if (!process.argv[2]) throw new Error('Укажите путь к .app.');
const app = resolve(process.argv[2]);
const runtime = join(app, 'Contents/Resources/macos-runtime');
const node = join(runtime, 'bin/node');
const provider = join(runtime, 'bin/luxury-link');
for (const file of [node, provider]) await access(file, constants.X_OK);
await access(join(runtime, 'browser-runtime/worker.mjs'));
const manifest = JSON.parse(await readFile(join(runtime, 'manifest.json'), 'utf8'));
if (manifest.target !== macosTarget()) throw new Error('Архитектура приложения не совпадает с машиной проверки.');
const execute = (command, args, options = {}) => {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Проверка ${command} не прошла.`);
};
execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
execute(provider, ['--self-test']);
execute(node, ['--input-type=module', '-e', "import {chromium} from 'playwright'; const browser=await chromium.launch({headless:true}); try {const page=await browser.newPage(); await page.goto('about:blank'); console.log('Packaged Chromium ready');} finally {await browser.close();}"], { cwd: join(runtime, 'browser-runtime'), env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: join(runtime, 'chromium'), PLAYWRIGHT_SKIP_BROWSER_GC: '1' } });
console.log('Packaged runtime checks passed. Keychain/login/proxy/send checks still require a Mac user session.');
