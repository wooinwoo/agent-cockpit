export const AGENT_PERMISSION_MODES = {
  codex: ['default', 'workspace', 'network', 'full'],
  claude: ['default', 'edits', 'auto', 'full'],
};

export function normalizeLaunchPermissions(value = {}) {
  return Object.fromEntries(Object.entries(AGENT_PERMISSION_MODES).map(([provider, modes]) => [provider,
    modes.includes(value?.[provider]) ? value[provider] : 'default',
  ]));
}

export function agentPermissionCommand(command, permissions) {
  // Explicit custom commands keep their own flags. Presets apply only to plain agent launchers.
  const mode = normalizeLaunchPermissions(permissions)[command];
  if (command === 'codex' && mode === 'workspace') return 'codex --no-daemon --sandbox=workspace-write --ask-for-approval=never';
  if (command === 'codex' && mode === 'network') return 'codex --no-daemon --sandbox=workspace-write --ask-for-approval=never --config=sandbox_workspace_write.network_access=true --config=check_for_update_on_startup=false';
  if (command === 'codex' && mode === 'full') return 'codex --no-daemon --dangerously-bypass-approvals-and-sandbox --config=check_for_update_on_startup=false';
  if (command === 'claude' && mode === 'edits') return 'claude --permission-mode=acceptEdits';
  if (command === 'claude' && mode === 'auto') return 'claude --permission-mode=auto';
  if (command === 'claude' && mode === 'full') return 'claude --dangerously-skip-permissions';
  return command;
}

export function unattendedCommandReady(command) {
  // Only known presets provide a verifiable startup policy; custom commands
  // keep their existing behavior and are not silently granted more access.
  return ['network', 'full'].some(codex => command === agentPermissionCommand('codex', { codex }))
    || command === agentPermissionCommand('claude', { claude: 'full' });
}
