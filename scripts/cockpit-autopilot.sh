#!/usr/bin/env bash
# Claude Code PreToolUse hook → Cockpit autopilot policy gate.
#
# Reads the hook JSON ({tool_name, tool_input, ...}) on stdin, asks the local
# Cockpit autopilot for a decision, and emits a PreToolUse permission decision.
#
# Fail-open: if Cockpit is not running (or errors), this returns "ask" so Claude
# Code falls back to its normal prompt — the hook never blocks you by breaking.
#
# Enable by adding to ~/.claude/settings.json:
#   "hooks": { "PreToolUse": [ { "matcher": "Bash|Edit|Write|MultiEdit",
#     "hooks": [ { "type": "command",
#       "command": "bash /path/to/agent-cockpit/scripts/cockpit-autopilot.sh" } ] } ] }
set -uo pipefail

PORT="${COCKPIT_PORT:-3847}"
INPUT="$(cat)"

RESP="$(curl -s --max-time 8 -X POST "http://127.0.0.1:${PORT}/api/autopilot/decide" \
  -H 'Content-Type: application/json' --data-binary "$INPUT" 2>/dev/null || true)"

if command -v jq >/dev/null 2>&1; then
  DECISION="$(printf '%s' "$RESP" | jq -r '.decision // "ask"' 2>/dev/null || echo ask)"
  REASON="$(printf '%s' "$RESP" | jq -r '.reason // "no response"' 2>/dev/null || echo 'no response')"
else
  DECISION="$(printf '%s' "$RESP" | sed -n 's/.*"decision":"\([a-z]*\)".*/\1/p')"
  REASON="$(printf '%s' "$RESP" | sed -n 's/.*"reason":"\([^"]*\)".*/\1/p' | tr -d '"')"
  [ -z "$DECISION" ] && DECISION=ask
  [ -z "$REASON" ] && REASON="no response"
fi

case "$DECISION" in
  approve) PD=allow ;;
  deny)    PD=deny ;;
  *)       PD=ask ;;
esac

# Build output safely (jq escapes the reason; fallback strips quotes above).
if command -v jq >/dev/null 2>&1; then
  jq -cn --arg pd "$PD" --arg r "autopilot: $REASON" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:$pd,permissionDecisionReason:$r}}'
else
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"%s","permissionDecisionReason":"autopilot: %s"}}\n' "$PD" "$REASON"
fi
