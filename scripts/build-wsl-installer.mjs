import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function wslConfig(original) {
  return { bundle: {
    targets: ['nsis'],
    // JSON Merge Patch must explicitly remove the old Node resource entries.
    resources: Object.fromEntries(Object.keys(original.bundle.resources || {}).map(name => [name, null])),
  } };
}

export function buildWslInstaller(source = fileURLToPath(new URL('../', import.meta.url))) {
  const originalPath = join(source, 'src-tauri/tauri.conf.json');
  const original = readFileSync(originalPath, 'utf8');
  const configPath = join(source, 'src-tauri/target/wsl-bundle-config.json');
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(wslConfig(JSON.parse(original)), null, 2) + '\n');
  execFileSync(process.execPath, [join(source, 'node_modules/@tauri-apps/cli/tauri.js'), 'build', '--bundles', 'nsis', '--config', configPath], {
    cwd: source, stdio: 'inherit', env: { ...process.env, CARGO_BUILD_JOBS: '2' },
  });
  if (readFileSync(originalPath, 'utf8') !== original) throw new Error('The Windows build unexpectedly changed the checked-in Tauri configuration');
}
