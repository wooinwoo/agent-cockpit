import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const helpers = ['cockpit-session', 'cockpit-board', 'cockpit-history'];

export function nativeResources(source, workflows) {
  const files = ['index.html', 'manifest.json', 'sw.js', 'package.json',
    'scripts/cockpit-session.mjs', 'scripts/cockpit-board.mjs', 'scripts/cockpit-history.mjs',
    'lib/board-service.js', 'lib/recovery-history.js', '.claude/skills/cockpit-session/SKILL.md',
    'rust-server/target/release/cockpit-server'];
  function visit(directory) {
    for (const entry of readdirSync(join(source, directory), { withFileTypes: true })) {
      const name = `${directory}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Bundled assets must not be symlinks: ${name}`);
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile() && /\.(js|css|woff2)$/.test(entry.name)) files.push(name);
    }
  }
  for (const directory of ['js', 'css', 'vendor']) visit(directory);
  // Only repository templates belong in an installer, not local user workflows.
  files.push(...workflows.filter(name => /^workflows\/[^/]+\.json$/.test(name)));
  const resources = {};
  for (const name of files) {
    if (!lstatSync(join(source, name)).isFile()) throw new Error(`Missing regular package resource: ${name}`);
    resources[`../${name}`] = name === 'rust-server/target/release/cockpit-server' ? './cockpit-server' : `./${name}`;
  }
  return resources;
}

export function nativeConfig(source, original, workflows) {
  const resources = Object.fromEntries(Object.keys(original.bundle.resources || {}).map(name => [name, null]));
  Object.assign(resources, nativeResources(source, workflows));
  const files = Object.fromEntries(helpers.map(name => [`/usr/bin/${name}`, `target/native-cli/${name}`]));
  return { bundle: { targets: ['deb'], resources, linux: { deb: { depends: ['tmux', 'git', 'nodejs (>= 18)'], files } } } };
}

export function prepareNativeClis(source, productName) {
  const directory = join(source, 'src-tauri/target/native-cli');
  const resourceName = `'${productName.replaceAll("'", "'\\''")}'`;
  mkdirSync(directory, { recursive: true });
  for (const name of helpers) {
    const target = join(directory, name);
    writeFileSync(target, `#!/bin/sh\ncockpit_resources="$(/usr/bin/dirname -- "$0")/../lib"/${resourceName}\nexec /usr/bin/env node "$cockpit_resources/scripts/${name}.mjs" "$@"\n`);
    chmodSync(target, 0o755);
  }
}

export function buildNativeInstaller(source = root) {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error('The native installer is currently verified only for Linux x64');
  }
  execFileSync('cargo', ['build', '--release', '--locked', '-j', '2', '--manifest-path', join(source, 'rust-server/Cargo.toml')], { cwd: source, stdio: 'inherit' });
  const originalPath = join(source, 'src-tauri/tauri.conf.json');
  const original = readFileSync(originalPath, 'utf8');
  const workflows = execFileSync('git', ['ls-files', '-z', '--', 'workflows'], { cwd: source, encoding: 'utf8' }).split('\0').filter(Boolean);
  const originalConfig = JSON.parse(original);
  const config = nativeConfig(source, originalConfig, workflows);
  const configPath = join(source, 'src-tauri/target/native-bundle-config.json');
  mkdirSync(dirname(configPath), { recursive: true });
  prepareNativeClis(source, originalConfig.productName);
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  execFileSync(process.execPath, [join(source, 'node_modules/@tauri-apps/cli/tauri.js'), 'build', '--bundles', 'deb', '--config', configPath], {
    cwd: source, stdio: 'inherit', env: { ...process.env, CARGO_BUILD_JOBS: '2' },
  });
  if (readFileSync(originalPath, 'utf8') !== original) throw new Error('The native build unexpectedly changed the checked-in Tauri configuration');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) buildNativeInstaller();
