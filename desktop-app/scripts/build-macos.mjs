import { prepareMacos, run } from './prepare-macos.mjs';
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--target')) throw new Error('Используйте macos:build [--target aarch64-apple-darwin|x86_64-apple-darwin].');
const target = await prepareMacos(args[1]);
run('npm', ['exec', '--', 'tauri', 'build', '--config', 'src-tauri/tauri.macos.conf.json', '--target', target]);
