# Autopilot

Let Claude Code agents run with minimal supervision. Every proposed tool call is
classified in microseconds; the safe majority runs automatically, the dangerous
minority is refused, and only genuinely ambiguous production actions interrupt you —
on screen when you're there, on your phone when you're not.

The policy isn't guessed. It's derived from **5,096 real supervisor decisions**
(`logs/decisions.jsonl`) and validated by replaying every one of them.

## How a decision is made

`lib/autopilot-policy.js` → `classify(tool, input)` returns one of four actions:

| action | meaning | example |
|---|---|---|
| `auto` | safe — run unattended | `ls`, `npm test`, edit on an ordinary path, `Read`, browser automation |
| `escalate` | production / cloud / deploy impact — ask a human | `aws s3api delete-bucket`, `git push … prod`, `kubectl delete`, remote DB, `~/.claude/settings.json` |
| `block` | irreversible / secret — never run | `rm -rf /`, `sudo rm`, `npm publish`, `git push --force`, `/etc/*`, `.ssh/*`, `.env` |
| `review` | unknown — needs judgment | anything no rule matched |

`lib/autopilot.js` turns those into a `decision`:

- **auto** → `approve`
- **block** → `deny`
- **escalate / review**
  - **attended** mode → `ask` (Claude Code shows its own prompt — you're at the keyboard)
  - **unattended** mode → phone approval via Telegram; `deny` on timeout or no channel (fail-closed)

## Validation (replay of 5,096 decisions)

`tests/lib/autopilot-policy.test.js` replays the full historical log:

- **64.2%** of calls resolve to `auto` deterministically — no LLM, zero cost
  (the old supervisor sent 47% to an LLM for the same judgment)
- **0** historically-dangerous commands leak to `auto`
- **20 / 20** historical hard-blocks stay blocked
- **65%** of the 95 non-approvals are caught by rules alone; the rest go to `review`
- 151 commands that were historically approved are now escalated/blocked — a
  deliberate conservative bias for unattended operation

## Architecture

```text
Claude Code (PreToolUse hook)
  └─ scripts/cockpit-autopilot.sh   # reads hook JSON, curls the endpoint
       └─ POST /api/autopilot/decide (routes/autopilot.js)
            └─ lib/autopilot.js  decide()
                 ├─ lib/autopilot-policy.js  classify()   # the rules
                 └─ Telegram bridge  requestApproval()     # phone, unattended only
```

- `GET /api/autopilot/status` — live mode + metrics + recent decisions
- `GET /api/autopilot/briefing` — morning summary (what ran, what escalated, what was blocked)
- `POST /api/autopilot/mode` — `{ "mode": "attended" | "unattended" }`

The hook is **fail-open**: if Cockpit isn't running it returns `ask`, so Claude Code
just falls back to its normal prompt. It never blocks you by breaking.

## Enable it

Add to `~/.claude/settings.json` (this is the activation step — off by default):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Edit|Write|MultiEdit",
        "hooks": [
          { "type": "command",
            "command": "bash /path/to/agent-cockpit/scripts/cockpit-autopilot.sh" }
        ]
      }
    ]
  }
}
```

Start in `attended` mode (the default). Flip to `unattended` only once you trust the
escalation set and have the Telegram bridge configured — that's what routes the hard
calls to your phone instead of denying them.

### Agent Wall status hooks (observation only)

`scripts/cockpit-agent-hook.sh` reports lifecycle state without returning an approval
decision, so it can run alongside Orca or another policy hook. Add the command to the
events below in `~/.codex/hooks.json` for Codex, using `codex` as its argument:

Codex uses `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`,
`PostToolUse`, `Stop`, `SessionEnd`, `SubagentStart`, and `SubagentStop`. Claude
uses the common events plus `Notification`, `PostToolUseFailure`, `StopFailure`,
and `TeammateIdle`.

```json
{"hooks":{"PermissionRequest":[{"hooks":[{"type":"command","command":"sh /path/to/agent-cockpit/scripts/cockpit-agent-hook.sh codex","timeout":3}]}]}}
```

Merge the event entry into the existing hook file; do not replace other hooks. For
Claude Code, register the same events in `~/.claude/settings.json` and pass `claude`.

Or use the idempotent installer. It preserves existing hooks (including Orca), writes
`.cockpit-backup`, and atomically replaces the JSON file:

```bash
node scripts/install-agent-hook.mjs codex
node scripts/install-agent-hook.mjs claude
```

Codex requires reviewing newly added non-managed hooks with `/hooks`.

## Safety model

- **Fail-open** at the hook (server down → normal prompt), **fail-closed** at the
  engine (unattended escalation with no phone channel → deny).
- Unattended `block` is absolute; unattended `escalate` requires an explicit phone
  approval and denies on timeout.
- The escalation set errs toward asking: cloud mutations, production pushes/deploys,
  remote databases, service restarts, and self-modifying config all escalate even
  when a similar command was historically auto-approved.
