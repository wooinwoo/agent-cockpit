import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wslConfig } from '../../scripts/build-wsl-installer.mjs';

test('Windows installer removes every Node resource without changing installer identity or user data', () => {
  const original = { identifier: 'com.cockpit.dashboard', bundle: {
    resources: { '../server.js': './', '../node_modules/*': './node_modules/', '../workflows/*': './workflows/' },
    windows: { nsis: { installMode: 'currentUser', installerHooks: 'installer-hooks.nsh' } },
  } };
  const before = JSON.stringify(original);
  const overlay = wslConfig(original);
  const merged = structuredClone(original);
  for (const [key, value] of Object.entries(overlay.bundle.resources)) {
    assert.equal(value, null);
    delete merged.bundle.resources[key];
  }
  assert.deepEqual(merged.bundle.resources, {});
  assert.deepEqual(overlay.bundle.targets, ['nsis']);
  assert.equal(overlay.identifier, undefined);
  assert.equal(overlay.bundle.windows, undefined);
  assert.equal(JSON.stringify(original), before);
});
