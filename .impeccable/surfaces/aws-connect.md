# AWS 연결

Mode: Operate. Extend the existing Instrument Bench system without changing the app's visual identity.

The user replaces three manual DB tunnel keepalive commands with explicit start, stop, status and authentication controls. The primary decision is which database tunnel to open and whether the current process requires intervention.

Keep two local tabs: DB tunnels and AWS authentication. Present target, profile, local endpoint, observed runtime state and actions in aligned rows. At smaller widths, rows become two-column and then single-column groups without horizontal clipping. Place connection editing in a disclosure and show one selected log below the list.

Make the existing-profile flow primary. MFA fields and submission belong in an explicitly optional disclosure; closing it clears the one-time code. Authentication controls precede authentication history. Show action feedback beside the affected form as well as the shared live status. Mobile form fields use 16px text and 44px minimum heights.

Authentication, status and tunnel controls follow the existing Cockpit login and same-origin protection, including authenticated proxy and remote access. Anonymous remote requests are rejected. Save target settings across server restarts without silently restoring authentication or tunnel processes. Use existing server-side AWS profiles; MFA temporary keys stay in server memory. Show remaining MFA time and state explicitly when an existing profile's expiry is unknown. Authentication release ends the profile's Cockpit-owned tunnels. Database passwords remain in the database client.

Use incumbent matte surfaces, hairlines, typography, four-pixel control corners and steel-blue focus. Green means a running process with an open local port; amber means preparation, external port use, retry or authentication attention. All controls retain 44-pixel minimum targets and visible keyboard focus. The tab bar supports arrow keys, Home and End.

Never equate an occupied local port with a successful DB query. Show external execution separately and expose external termination only after exact process identification. Show missing dependencies, request failures, empty lists and pending mutations. Preserve form drafts during refresh. Clear an entered MFA code on submission or when leaving the view. Pause refresh when the tab or page is hidden.

On an initial load failure, replace the loading label with an explicit retry message and withhold connection editing and authentication forms until profile data is available. A successful refresh restores the forms and clears the load error without erasing unrelated action errors.

Lock editing and form inputs while a mutation is pending, including redraws triggered by log controls. If a selected profile disappears, clear its MFA code and refresh authentication metadata for the new selection. With no profiles, disable authentication controls. A failed clipboard operation must report failure. Corrupt persisted settings must never silently become presets or overwrite the source file.

Cockpit-owned process exits retry at most five times; authentication and permission errors stop automatic retries. Existing external processes are neither automatically stopped nor adopted.

Sources: `js/aws-connect.js`, `css/aws-connect.css`, `index.html`. Verification: `scripts/verify-aws-connect.mjs`; passed fixture results and seven screenshots under `docs/_local/aws-connect-verification/`. The recorded verification did not contact real AWS (`actualAws: false`).
