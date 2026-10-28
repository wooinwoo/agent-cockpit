---
name: Cockpit
description: A terminal-first operations bench built from matte surfaces, engraved labels, hairline divisions, and restrained signal lights.
colors:
  terminal-black: "#080a0b"
  bench-black: "#090b0c"
  rail-matte: "#0d0f10"
  panel-matte: "#131619"
  control-matte: "#191d20"
  text-bright: "#f2f5f6"
  text-primary: "#d5dadd"
  text-muted: "#9ba4a9"
  text-engraved: "#7d878c"
  hairline: "rgba(218, 226, 230, 0.13)"
  hairline-active: "rgba(111, 165, 211, 0.64)"
  focus-steel-blue: "#6fa5d3"
  focus-blue-bright: "#9bc2e1"
  signal-green: "#5fd18b"
  attention-amber: "#e3ad5b"
  fault-red: "#ef7373"
  terminal-ink: "#f5f1e8"
  terminal-cyan: "#7ee8fb"
typography:
  title:
    fontFamily: "Pretendard Variable, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "1rem"
    fontWeight: 650
    lineHeight: 1.5
  body:
    fontFamily: "Pretendard Variable, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "0.8rem"
    fontWeight: 500
    lineHeight: 1.5
  label:
    fontFamily: "JetBrains Mono, Cascadia Code, SFMono-Regular, monospace"
    fontSize: "0.58rem"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "0.1em"
  terminal:
    fontFamily: "JetBrains Mono, Cascadia Code, D2Coding, NanumGothicCoding, Pretendard Variable, monospace"
    fontSize: "16px"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "0"
rounded:
  xs: "3px"
  sm: "4px"
  md: "5px"
spacing:
  unit: "4px"
components:
  button-deck:
    backgroundColor: "transparent"
    textColor: "{colors.text-muted}"
    rounded: "{rounded.sm}"
    padding: "0 9px"
    height: "31px"
  button-deck-hover:
    backgroundColor: "rgba(231, 237, 240, 0.075)"
    textColor: "{colors.text-bright}"
    rounded: "{rounded.sm}"
  button-terminal-primary:
    backgroundColor: "{colors.signal-green}"
    textColor: "#08110d"
    rounded: "{rounded.sm}"
    height: "34px"
  nav-rail:
    backgroundColor: "transparent"
    textColor: "{colors.text-engraved}"
    rounded: "{rounded.sm}"
    padding: "5px 2px"
    height: "51px"
  nav-rail-active:
    backgroundColor: "{colors.control-matte}"
    textColor: "{colors.text-bright}"
    rounded: "{rounded.sm}"
    height: "51px"
  session-tab:
    backgroundColor: "transparent"
    textColor: "{colors.text-engraved}"
    rounded: "0"
    padding: "0 12px"
    height: "36px"
  session-tab-active:
    backgroundColor: "{colors.panel-matte}"
    textColor: "{colors.text-bright}"
    rounded: "0"
    height: "36px"
  input-terminal-search:
    backgroundColor: "{colors.bench-black}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.xs}"
    padding: "4px 8px"
  metadata-tag:
    backgroundColor: "transparent"
    textColor: "{colors.text-muted}"
    rounded: "{rounded.xs}"
    padding: "1px 5px"
    height: "19px"
  terminal-panel-header:
    backgroundColor: "#101214"
    textColor: "{colors.text-muted}"
    rounded: "0"
    padding: "0 9px"
    height: "29px"
  signal-lamp-connected:
    backgroundColor: "{colors.signal-green}"
    rounded: "50%"
    size: "7px"
---

# Design System: Cockpit

## Overview

**Creative North Star: "Instrument Bench"**

Cockpit is a terminal multiplexer with nearby operations, expressed as a precise electronic instrument bench. The terminal is the working surface; the activity rail, status strip, session row, and compact controls form the frame around it. Matte near-black planes, engraved micro-labels, and hairline dividers make the interface feel measured and durable rather than decorative.

The system is dense without feeling busy. State is communicated through a few restrained signals, active boundaries, and exact typography, while secondary operations remain quiet until needed. The visual anti-reference is a glossy reporting dashboard: no ambient gradients, glass effects, oversized cards, or ornamental glow should compete with terminal output.

**Key Characteristics:**

- Terminal-first composition with operations arranged at the edges.
- Matte, closely stepped neutral surfaces separated by hairlines.
- Steel-blue focus and selection with green, amber, and red reserved for state.
- Compact sans-serif controls paired with mono labels and terminal text.
- Nearly square controls, shallow corners, and flat resting surfaces.

## Colors

The palette is a low-chroma graphite bench with cool steel-blue interaction cues and sparse instrument-light states.

### Primary

- **Focus Steel Blue** (`focus-steel-blue`): Active borders, focus outlines, split dividers, and selected-control emphasis.
- **Bright Focus Blue** (`focus-blue-bright`): Branch metadata and fine active text that needs more luminance than a border.

### Secondary

- **Signal Green** (`signal-green`): Connected, running, and successful states; also the exceptional terminal-first primary action.

### Tertiary

- **Attention Amber** (`attention-amber`): Waiting, reconnecting, attention, and warning states.
- **Fault Red** (`fault-red`): Disconnected, destructive, and fault states.
- **Terminal Cyan** (`terminal-cyan`): ANSI terminal emphasis and the terminal cursor, not general chrome.

### Neutral

- **Terminal Black** (`terminal-black`): The uninterrupted xterm canvas and split leaves.
- **Bench Black** (`bench-black`): The application foundation behind all tools.
- **Rail Matte** (`rail-matte`): Activity rail, top instrument strip, and session strip.
- **Panel Matte** (`panel-matte`): Active session tabs, overlays, and secondary panels.
- **Control Matte** (`control-matte`): Selected navigation and active control surfaces.
- **Bright Text** (`text-bright`): Active labels and highest-priority interface text.
- **Primary Text** (`text-primary`): Default readable chrome text.
- **Muted Text** (`text-muted`): Inactive controls and supporting information.
- **Engraved Text** (`text-engraved`): Micro-labels, indices, and deeply subordinate metadata.
- **Hairline** (`hairline`): Structural divisions between fixed regions and controls.
- **Active Hairline** (`hairline-active`): Selected tabs and active panel boundaries.
- **Terminal Ink** (`terminal-ink`): The terminal's warm primary foreground.

**The Signal Is State Rule.** Steel blue means focus or selection; green means healthy or running; amber means attention; red means fault or destructive action. Never use these colors as ambient decoration.

## Typography

**Display Font:** Pretendard Variable (with system sans-serif fallback)
**Body Font:** Pretendard Variable (with system sans-serif fallback)
**Label/Mono Font:** JetBrains Mono (with Cascadia Code and platform monospace fallbacks)

**Character:** Pretendard keeps compact controls calm and legible, while JetBrains Mono makes session identifiers, state readouts, and terminal content feel calibrated. Hierarchy comes from weight, spacing, and contrast rather than dramatic size changes.

### Hierarchy

- **Title** (650, `title`, 1.5): Empty-state titles, modal headings, and compact section emphasis.
- **Body** (500, `body`, 1.5): Controls, supporting copy, and operational descriptions.
- **Label** (400, `label`, 0.1em tracking, uppercase where used): Workspace labels and fixed instrument legends; related session and connection labels keep normal weight at their neighboring compact sizes.
- **Terminal** (500 regular / 800 bold, `terminal`, 1.4): xterm output and commands; preserve a minimum readable size and zero letter spacing.

**The Engraved Label Rule.** Use mono uppercase labels only for fixed instrument legends and compact state readouts; prose and ordinary actions remain in the sans-serif face.

## Layout

Desktop uses a fixed 68px activity rail and a fixed 44px top instrument strip. The application canvas fills the remaining viewport, and the terminal begins with a 36px horizontally scrollable session row. The terminal itself receives every remaining pixel; secondary views use compact 14px by 16px outer padding.

At 1180px, supporting status content begins to collapse. At 860px, action labels disappear before the controls do. At 600px and below, the top strip is removed, the activity rail becomes a 58px bottom navigation bar, the session row grows to 44px, and terminal shortcut keys occupy a 50px touch strip. Mobile touch controls retain a minimum 44px target while the terminal remains the dominant viewport.

Spacing follows the compiled 4px unit, most often combined into tight 6px, 8px, 10px, 12px, and 14px relationships. Preserve edge alignment across the rail, strips, headers, and terminal panels rather than introducing isolated card grids.

## Elevation & Depth

The system is flat by default. Depth comes from stepped matte tones, one-pixel boundaries, and active inset strokes; the terminal canvas, navigation, tabs, cards, and tool strips do not float. Shadows are reserved for content that truly overlays the bench, such as search, menus, dialogs, and selection toolbars.

### Shadow Vocabulary

- **Low mechanical lift** (`0 2px 5px rgba(0, 0, 0, 0.22)`): The smallest transient lift where a local overlay needs separation.
- **Tool overlay** (`0 8px 20px rgba(0, 0, 0, 0.28)`): Terminal search and floating selection tools.
- **Dialog overlay** (`0 16px 36px rgba(0, 0, 0, 0.34)`): Dialogs, menus, settings, and command surfaces above the workspace.

**The Flat-by-Default Rule.** If a surface does not cover another surface, separate it with tone and a hairline instead of a shadow.

## Shapes

The form language is rectangular and instrument-like. Small metadata tags use the tightest 3px corners, everyday controls use 4px corners, and ordinary containers use 5px corners. Overlays may reach 6px, but session tabs and structural strips remain square so their edges align with the bench grid. Perfect circles are reserved for state lamps and other literal indicators.

Borders are single-pixel hairlines. Active navigation adds an inset steel-blue edge rather than swelling the whole control, and selected session tabs use an active outline inside the existing geometry. Avoid pill silhouettes except for compact numeric or state badges that already behave as indicators.

## Components

### Buttons

Buttons feel like quiet instrument switches, not calls to spectacle.

- **Shape:** Compact rectangular controls with shallow 4px corners.
- **Primary:** The top-strip action remains transparent and high-contrast; a solid signal-green fill is reserved for the exceptional action that starts a terminal.
- **Hover / Focus:** Hover adds a faint matte wash and hairline; keyboard focus uses a 2px steel-blue outline with a 2px offset.
- **Secondary / Ghost:** Muted text on transparent surfaces, becoming bright only on hover or selection.

### Chips

Metadata is engraved into the terminal header rather than floated above it.

- **Style:** Transparent background, 1px hairline, 3px corners, mono micro-type, and 1px by 5px padding.
- **State:** Branch text uses bright steel blue; runtime health uses signal green; waiting and buffer pressure use amber; idle data remains muted.

### Cards / Containers

- **Corner Style:** Shallow 5px corners for ordinary containers; 6px only for overlays.
- **Background:** Closely stepped bench, rail, panel, and control matte tones.
- **Shadow Strategy:** None at rest; use the overlay vocabulary only when content covers the work surface.
- **Border:** One-pixel hairlines carry structure and hover feedback.
- **Internal Padding:** Compact 10px to 16px padding, depending on information density.

### Inputs / Fields

- **Style:** Bench-black fill, one-pixel hairline, 3px to 4px corners, and compact padding. Terminal search uses mono text to match the content being searched.
- **Focus:** Steel-blue border plus the global visible 2px focus outline; dialog fields may add the established subtle focus wash.
- **Error / Disabled:** Fault red is for actual errors; disabled controls reduce emphasis without introducing a new hue.

### Navigation

The desktop activity rail uses centered line icons above engraved labels. Inactive items are muted; hover reveals a matte wash and hairline; active items use a darker control surface, bright text, an active border, and a thin inset steel-blue edge. On mobile the same hierarchy moves to the bottom and the active edge rotates to the top. Session navigation is a separate square-edged mono strip with two-digit indices and tiny state lamps.

A 44px panel toggle at the start of the desktop instrument strip hides the activity rail while retaining the instrument strip and expands the application into its 68px space. The same button restores navigation; its accessible label and expansion state follow the visible state. The preference persists across reloads, while the mobile bottom navigation remains available.

### Terminal Panel

The terminal panel is the signature component. It uses the dedicated terminal-black canvas, a 29px metadata header on desktop, warm terminal ink, ANSI semantic color, and a thin active inset edge. Split dividers are 3px hit lines that turn steel blue on hover or drag. On mobile, per-panel headers disappear in favor of the shared session row so output receives more vertical space.

### Report Library / Preview

The report tab extends the existing navigation and Instrument Bench frame with a file library beside a reading surface. Its management controls use the incumbent matte surfaces, text colors, hairlines, and steel-blue focus cues.

- **Structure:** Desktop places a narrow library (260px to 320px) beside the flexible preview with a 16px gap. At 900px and below, the library sits above the preview, its scrollable list is capped at 240px, and the detail region retains room for reading. A persistent header action can hide the library and registration region, leaving the preview in one full-width column within the application; selection, filters, and preview contents remain in place.
- **Controls:** File-path registration opens in a disclosure above the library. Search, format selection, and actions retain 44px minimum heights, 4px corners, and visible 2px focus outlines with a 2px offset.
- **Rows:** Title, format, project/session metadata, modification time, and filename form a compact vertical stack. Hover and selection use the existing panel tone; selection adds a one-pixel inset steel-blue edge.
- **Source identity:** The detail header keeps the registered source path visible beside actions for copying the path, downloading the file, and removing its library entry. Selecting or refreshing reads the source file's current contents.
- **Reading surface:** Markdown renders inside an isolated white document with dark ink, system sans-serif body text (15px, 1.75 line height), a 75ch maximum measure, and distinct heading sizes (26px, 21px, and 18px). These values belong to the report document, while management chrome keeps the existing interface tokens. HTML retains its source styling in an isolated, script-free preview; external resources are blocked.
- **States:** Loading, empty library, no search results, no selection, and failed source reads have explicit copy. Failed reads expose a retry action. A successful registration or removal remains visible if the following list refresh fails, with the refresh error stated separately.

## Do's and Don'ts

### Do:

- **Do** give the terminal every remaining pixel after the fixed navigation and session strips.
- **Do** use one-pixel hairlines and stepped matte tones to define regions.
- **Do** reserve steel blue, green, amber, and red for their documented interaction or state meanings.
- **Do** keep labels short, mono, and compact when they behave like engraved instrument legends.
- **Do** preserve visible focus, reduced-motion behavior, keyboard reachability, and 44px mobile touch targets.

### Don't:

- **Don't** turn secondary operations into a dashboard that competes with the terminal.
- **Don't** add ambient gradients, glass blur, decorative glow, or resting card shadows.
- **Don't** use signal colors to decorate neutral surfaces or large regions.
- **Don't** round structural strips or session tabs into floating pills.
- **Don't** add oversized headings, loose marketing spacing, or decorative illustration to operational screens.
