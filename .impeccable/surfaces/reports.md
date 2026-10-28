---
version: 1
slug: "reports"
primary_target: "js/reports.js"
related_targets: ["css/reports.css"]
---

# Reports

Mode: Operate

Scope: The existing Cockpit report tab for registering, finding, opening, downloading, and removing HTML/Markdown file entries.

Job: Developers collect reports from several sessions, identify each report by project, session, modification time, and source path, then read the current source file.

Direction: Extend the Instrument Bench navigation and control language. Keep the library beside the preview on desktop; at 900px and below, place the library above the preview. A header action can hide the library and registration region so the preview uses the report region's full width without fullscreen. Preserve filters, selection, and the preview frame when toggling. Registration stays in a disclosure, and controls keep 44px minimum heights.

Application frame: The desktop instrument strip's first panel button independently hides or restores the 68px Cockpit activity rail. The strip and restore button remain visible. The preference survives reloads while mobile bottom navigation remains available.

Reading: The preview serves comprehension inside the management surface. Markdown has an isolated white document and a 75ch reading measure. HTML retains its source styling with scripts and external resources blocked. The white surface and larger document type are local to the preview.

States: Keep empty, loading, search, selection, and retry states explicit. After a saved registration or removal, retain the resulting entry state and show any subsequent list refresh error. Removing an entry preserves its source file.

Evidence: `docs/_local/reports-verification/results.json` records a passed Rust release verification at `2026-10-12T08:17:35.499Z`, with 20 checks across four viewports. The final functional rerun did not recapture screenshots. Eight PNGs in that directory came from the preceding capture of the same product code and cover open and closed navigation. This brief records that evidence without running another browser pass.
