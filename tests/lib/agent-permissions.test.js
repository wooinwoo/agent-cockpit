import test from 'node:test';
import assert from 'node:assert/strict';
import { agentPermissionCommand, normalizeLaunchPermissions, unattendedCommandReady } from '../../js/agent-permissions.js';
import { validateRecoveryCommand } from '../../lib/durable-terminal.js';

test('permission presets preserve explicit commands and produce recovery-compatible launchers', () => {
  assert.deepEqual(normalizeLaunchPermissions({ codex: 'bad', claude: 'auto' }), { codex: 'default', claude: 'auto' });
  assert.equal(agentPermissionCommand('codex', {}), 'codex');
  assert.equal(agentPermissionCommand('codex --model custom', { codex: 'full' }), 'codex --model custom');
  assert.equal(agentPermissionCommand('claude login', { claude: 'full' }), 'claude login');
  assert.equal(agentPermissionCommand('opencode', { codex: 'full' }), 'opencode');
  const restricted = agentPermissionCommand('codex', { codex: 'workspace' });
  assert.match(restricted, /--no-daemon/);
  assert.match(restricted, /--sandbox=workspace-write --ask-for-approval=never/);
  assert.doesNotMatch(restricted, /dangerously/);
  assert.match(agentPermissionCommand('claude', { claude: 'edits' }), /acceptEdits/);
  for (const [provider, modes] of Object.entries({ codex: ['workspace', 'network', 'full'], claude: ['edits', 'auto', 'full'] })) {
    for (const mode of modes) assert.equal(validateRecoveryCommand(agentPermissionCommand(provider, { [provider]: mode })), agentPermissionCommand(provider, { [provider]: mode }));
  }
});

test('overnight startup requires an explicit noninteractive preset with Cockpit network access', () => {
  const command = agentPermissionCommand('codex', { codex: 'network' });
  assert.match(command, /--config=sandbox_workspace_write.network_access=true/);
  assert.match(command, /--config=check_for_update_on_startup=false/);
  assert.doesNotMatch(command, /dangerously/);
  assert.equal(unattendedCommandReady(command), true);
  assert.equal(unattendedCommandReady(command + ' --ask-for-approval=on-request'), false);
  assert.equal(unattendedCommandReady(agentPermissionCommand('codex', { codex: 'workspace' })), false);
  assert.equal(unattendedCommandReady('codex'), false);
  assert.equal(unattendedCommandReady('claude --permission-mode=acceptEdits'), false);
  assert.equal(unattendedCommandReady('claude --dangerously-skip-permissions'), true);
});
