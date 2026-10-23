import { chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function macosTarget(platform = process.platform, arch = process.arch, requested, translated = false) {
  if (translated) throw new Error('Сборка через Rosetta запрещена: нужен нативный Node.js, Python и Chromium одной архитектуры.');
  if (platform !== 'darwin') throw new Error('Сборка macOS выполняется на Mac или macOS runner.');
  const target = { arm64: 'aarch64-apple-darwin', x64: 'x86_64-apple-darwin' }[arch];
  if (!target || requested && requested !== target) throw new Error('Node.js, Python, Chromium и Rust должны собираться на Mac нужной архитектуры. Cross/universal сборка не поддерживается.');
  return target;
}
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: appRoot, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} завершился с ошибкой ${result.status}.`);
}

export function verifyMacArchitecture(binary, architecture, execute = run) {
  if (!['arm64', 'x86_64'].includes(architecture)) throw new Error('Unsupported macOS binary architecture.');
  // lipo consumes every argument after -verify_arch as an architecture name.
  // Its input filename must therefore precede the command and its varargs.
  execute('/usr/bin/lipo', [binary, '-verify_arch', architecture]);
}

async function resetStage(stage) {
  const parent = await realpath(join(appRoot, 'src-tauri'));
  if (resolve(stage) !== join(parent, 'macos-runtime')) throw new Error('Некорректная папка подготовки.');
  const info = await lstat(stage).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (info) {
    if (info.isSymbolicLink() || !(await realpath(stage)).startsWith(parent + sep)) throw new Error('Нельзя очищать ссылку или папку вне проекта.');
    await rm(stage, { recursive: true });
  }
  await mkdir(stage, { recursive: true });
}

export async function prepareMacos(requested) {
  const translation = process.platform === 'darwin' ? spawnSync('/usr/sbin/sysctl', ['-in', 'sysctl.proc_translated'], { encoding: 'utf8' }) : null;
  const target = macosTarget(process.platform, process.arch, requested, translation?.stdout?.trim() === '1');
  const hostArch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
  const os = spawnSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' });
  if (os.status !== 0 || Number(os.stdout.trim().split('.')[0]) < 14) throw new Error('Требуется macOS 14 или новее.');
  const stage = join(appRoot, 'src-tauri', 'macos-runtime');
  await resetStage(stage);
  const runtime = join(stage, 'browser-runtime');
  const bin = join(stage, 'bin');
  await mkdir(runtime, { recursive: true });
  await mkdir(bin, { recursive: true });
  for (const entry of await readdir(join(appRoot, 'browser-runtime'), { withFileTypes: true })) {
    if (entry.isFile() && (entry.name.endsWith('.mjs') && !entry.name.endsWith('.test.mjs') || ['package.json', 'package-lock.json', 'automation-defaults.json'].includes(entry.name))) {
      await copyFile(join(appRoot, 'browser-runtime', entry.name), join(runtime, entry.name));
    }
  }
  const node = join(bin, 'node');
  await copyFile(await realpath(process.execPath), node);
  await chmod(node, 0o755);
  verifyMacArchitecture(node, hostArch);
  const dylibs = spawnSync('/usr/bin/otool', ['-L', node], { encoding: 'utf8' });
  if (dylibs.status !== 0 || dylibs.stdout.split('\n').slice(1).some(line => line.trim() && !/^\s*\/(usr\/lib|System\/Library)\//.test(line))) throw new Error('Нужен самостоятельный Node.js с nodejs.org или actions/setup-node, без Homebrew dylib-зависимостей.');
  run('npm', ['ci', '--omit=dev', '--ignore-scripts'], { cwd: runtime });
  const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: join(stage, 'chromium'), PLAYWRIGHT_SKIP_BROWSER_GC: '1' };
  run(node, [join(runtime, 'node_modules/playwright/cli.js'), 'install', 'chromium'], { cwd: runtime, env });
  const browserPath = spawnSync(node, ['--input-type=module', '-e', "import {chromium} from 'playwright'; console.log(chromium.executablePath());"], { cwd: runtime, env, encoding: 'utf8' });
  if (browserPath.status !== 0 || !browserPath.stdout.trim()) throw new Error('Не найден встроенный Chromium.');
  verifyMacArchitecture(browserPath.stdout.trim(), hostArch);

  const python = process.env.LUXURY_BUILD_PYTHON || 'python3';
  const pythonArch = spawnSync(python, ['-c', 'import platform; print(platform.machine())'], { encoding: 'utf8' });
  if (pythonArch.status !== 0 || pythonArch.stdout.trim() !== hostArch) throw new Error('Python должен соответствовать архитектуре сборки.');
  const build = join(stage, '.build');
  run(python, ['-m', 'venv', join(build, 'venv')]);
  const venvPython = join(build, 'venv/bin/python3');
  run(venvPython, ['-m', 'pip', 'install', '-r', join(appRoot, 'scripts/macos-build-requirements.txt')]);
  const providers = resolve(appRoot, '../examples/local_rendering');
  run(venvPython, ['-m', 'PyInstaller', '--noconfirm', '--clean', '--onefile', '--name', 'luxury-link', '--target-architecture', hostArch,
    '--distpath', bin, '--workpath', join(build, 'work'), '--specpath', build, '--paths', providers,
    '--hidden-import', 'eql', '--hidden-import', 'kartatai', '--add-data', join(providers, 'eql_categories.json') + ':.', join(providers, 'generate_link.py')]);
  run(join(bin, 'luxury-link'), ['--self-test']);
  verifyMacArchitecture(join(bin, 'luxury-link'), hostArch);

  const iconset = join(build, 'Luxury.iconset');
  await mkdir(iconset, { recursive: true });
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      run('/usr/bin/sips', ['-z', String(size * scale), String(size * scale), join(appRoot, 'src-tauri/icons/icon.png'), '--out', join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)]);
    }
  }
  run('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', join(appRoot, 'src-tauri/icons/icon.icns')]);
  run(node, ['--input-type=module', '-e', "import {chromium} from 'playwright'; const browser=await chromium.launch({headless:true}); try {const page=await browser.newPage(); await page.goto('about:blank'); console.log('Bundled Chromium ready');} finally {await browser.close();}"], { cwd: runtime, env });
  await rm(build, { recursive: true });
  const packageJson = JSON.parse(await readFile(join(runtime, 'node_modules/playwright/package.json'), 'utf8'));
  await writeFile(join(stage, 'manifest.json'), JSON.stringify({ target, node: process.version, playwright: packageJson.version, minimumMacOS: '14.0', signing: 'ad-hoc' }, null, 2));
  console.log(`macOS runtime prepared: ${target}`);
  return target;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  prepareMacos().catch(error => { console.error(error.message); process.exitCode = 1; });
}
