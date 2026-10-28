import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { nativeConfig, nativeResources, prepareNativeClis } from '../../scripts/build-native-installer.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cockpit-native-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const names = ['index.html', 'manifest.json', 'sw.js', 'package.json',
    'scripts/cockpit-session.mjs', 'scripts/cockpit-board.mjs', 'scripts/cockpit-history.mjs',
    'lib/board-service.js', 'lib/recovery-history.js', '.claude/skills/cockpit-session/SKILL.md',
    'rust-server/target/release/cockpit-server', 'js/main.js', 'css/main.css', 'vendor/fonts/font.woff2',
    'workflows/template.json', 'workflows/private.json', 'vendor/private.json', '.cockpit-token', 'server.js'];
  for (const name of names) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), 'fixture');
  }
  return root;
}

test('native resources include nested fonts and CLI support, excluding local state and the Node backend', async t => {
  const root = await fixture(t);
  const resources = nativeResources(root, ['workflows/template.json']);
  for (const name of ['vendor/fonts/font.woff2', 'scripts/cockpit-history.mjs', 'lib/recovery-history.js', '.claude/skills/cockpit-session/SKILL.md']) {
    assert.equal(resources[`../${name}`], `./${name}`);
  }
  assert.equal(resources['../rust-server/target/release/cockpit-server'], './cockpit-server');
  assert.equal(resources['../workflows/template.json'], './workflows/template.json');
  for (const name of ['workflows/private.json', 'vendor/private.json', '.cockpit-token', 'server.js']) assert.equal(resources[`../${name}`], undefined);
});

test('native overlay removes legacy resource entries without mutating the original configuration', async t => {
  const root = await fixture(t);
  const original = { bundle: { resources: { '../server.js': './', '../node_modules/*': './node_modules/' } } };
  const bytes = JSON.stringify(original);
  const config = nativeConfig(root, original, []);
  assert.equal(config.bundle.resources['../server.js'], null);
  assert.equal(config.bundle.resources['../node_modules/*'], null);
  assert.deepEqual(config.bundle.targets, ['deb']);
  assert.deepEqual(config.bundle.linux.deb.depends, ['tmux', 'git', 'nodejs (>= 18)']);
  assert.equal(JSON.stringify(original), bytes);
});

test('missing native executable fails preparation', async t => {
  const root = await fixture(t);
  await rm(join(root, 'rust-server/target/release/cockpit-server'));
  assert.throws(() => nativeResources(root, []), { code: 'ENOENT' });
});

test('symlinked frontend assets cannot pull outside files into the package', { skip: process.platform === 'win32' }, async t => {
  const root = await fixture(t);
  await symlink(join(root, '.cockpit-token'), join(root, 'vendor/external.js'));
  assert.throws(() => nativeResources(root, []), /must not be symlinks/);
});

test('packaged CLI commands work from a clean PATH and preserve quoted arguments', { skip: process.platform !== 'linux' }, async t => {
  const root = await fixture(t);
  const config = nativeConfig(root, { bundle: {} }, []);
  prepareNativeClis(root, 'Cockpit');
  const bin = join(root, 'usr/bin');
  const scripts = join(root, 'usr/lib/Cockpit/scripts');
  await mkdir(bin, { recursive: true });
  await mkdir(scripts, { recursive: true });
  await symlink(process.execPath, join(bin, 'node'));
  for (const name of ['cockpit-session', 'cockpit-board', 'cockpit-history']) {
    const target = join(root, 'src-tauri', config.bundle.linux.deb.files[`/usr/bin/${name}`]);
    assert.equal((await stat(target)).mode & 0o777, 0o755);
    await copyFile(target, join(bin, name));
    await writeFile(join(scripts, `${name}.mjs`), 'console.log(JSON.stringify(process.argv.slice(2)));');
    const args = ['a b', '$(do-not-run)', '한글', ''];
    const output = execFileSync(name, args, { env: { PATH: bin }, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(output), args);
  }
});
