---
name: delegate-to-claude
description: Delegate a bounded repository task from Codex to local Claude Code when the user explicitly asks to call, consult, compare with, or assign work to Claude. Do not trigger for ordinary Claude or Codex discussion.
---

# Delegate to Claude

Launch one Claude Code worker with `scripts/claude-agent.mjs`, then treat its output as input to Codex's own verification and final answer. The wrapper reports `running`, heartbeat, and `done` to the local Cockpit server so Session Status stays live during the run.

## Modes

- `review`: Read-only investigation, planning, review, or second opinion. This is the default.
- `work`: File edits allowed. Use only when the user's request already authorizes repository changes.

Delegation never expands the user's permissions or task scope. Do not pass secrets. Do not use `bypassPermissions`.

## Workflow

1. Give Claude one bounded task with the goal, relevant paths, constraints, and requested output. Avoid sending the whole conversation.
2. Tell the user that this skill is invoking Claude before starting the external run.
3. From the repository root, pipe the task through stdin:

   ```bash
   printf '%s\n' "$TASK" | .agents/skills/delegate-to-claude/scripts/claude-agent.mjs review
   ```

   For authorized edits, replace `review` with `work`. An optional second argument selects the model; the default is `sonnet`.
4. If Claude needs a permission unavailable in the selected mode, stop and report it. Do not broaden permissions automatically.
5. Inspect Claude's result and any diff. Codex remains responsible for running the relevant checks and deciding what to keep.

Use one worker unless the user explicitly asks for multiple Claude agents or parallel delegation.
