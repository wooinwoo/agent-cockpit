# AI 계정

Mode: Operate. Preserve the existing Instrument Bench identity and row-based account list.

The primary decisions are which existing session receives an account change and which account opens a new terminal. Show the chosen session as explicit context, retaining session buttons on account rows rather than adding a separate session picker. Keep saved default login distinct from observed live connection state. Stored authentication and quota data do not prove that a session currently uses that account.

Preserve unsaved budget input, editing focus and scroll during refresh. On account-list failure, keep the previous list with an explicit stale-data error and disable account actions until a successful refresh. Never recommend hub profiles the launcher would reject. Do not present unknown quota as zero.

Use readable account names, 44px actions, visible keyboard focus, and 16px form controls. Keep filters available and preserve the existing account registration disclosure. Confirm layouts at 1080x1920, 720x1280 and 390x844.

Sources: `js/ai-accounts.js`, `js/ai-accounts-view.js`, `css/ai-accounts.css`, `index.html`. Browser proof: `scripts/verify-session-maintenance-ui.mjs`; mutations and terminal connections are mocked, so no live account switch is implied.
