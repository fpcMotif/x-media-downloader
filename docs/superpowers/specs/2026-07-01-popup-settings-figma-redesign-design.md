# Popup + Settings redesign (Figma round 2) — design

**Date:** 2026-07-01
**Status:** Approved for planning
**Figma file:** [X Media Downloader — Popup & Settings](https://www.figma.com/design/aPtze9cPET1OxKNN9hmVWG) (extended in place, not replaced)

## Goal

The popup ([`src/entrypoints/popup/App.tsx`](../../../src/entrypoints/popup/App.tsx)) drifted back into a scroll-heavy mini-dashboard after the [popup-clear-and-harvest](2026-07-01-popup-clear-and-harvest-design.md) work landed — 6 stacked cards (monitor, page actions, mode/clear settings, Knowledge Capture list+exports, Local data wipes, Recent). This restores the original "popup = action surface, Settings = config surface" split from the June 2026 redesign (implemented directly against the same Figma file, no committed spec), and brings the Settings sidebar/panels up to date with two panels that never got a Figma pass: **Worklist & clearing** and **Knowledge Capture**.

Deliverable for this round: updated Figma artboards (source of truth for the next implementation plan) + this spec. Code implementation is a separate, later step.

## Decisions

1. **Popup scope:** trim to pure action-surface content. The harvested-conversation list, per-conversation Tree/MD exports, "Export all (JSONL)", and the "Local data" wipe buttons (Clear download history / Clear harvest archive) move **out of the popup entirely** — they already exist in Settings (History panel has "Clear history"; the new Knowledge Capture panel below covers the rest) and were pure duplication.
2. **Harvest toggle stays, list leaves:** "Harvest tweets" is a background setting, not tab-scoped — but the user flips it often enough that losing one-tap access from the popup was worse than the clutter. It survives as a single compact switch row (no list, no export buttons) with a link to Settings.
3. **Figma file:** extended the existing file in place rather than starting fresh, reusing its established tokens/components.
4. **Settings scope:** built the sidebar shell fix (2 missing nav items) plus the two panels most affected by this change (Worklist & clearing, Knowledge Capture) in Figma. General/Downloads/Filters/Cloud/History/About are unchanged and were not re-mocked.
5. **Theme coverage:** both light and dark, matching the existing artboard pairing convention (one popup mock per theme; sidebar fix applied to both Settings shells; one new panel mocked per theme — Worklist in light, Knowledge Capture in dark — so together the two new panels also double as the missing light/dark pair).

## Popup — trimmed to an action surface

Artboards: **Popup · Active · Light** (`1:4`) and **Popup · Idle · Dark** (`2:2`), same 380px-wide shell, now ~793–866px tall (was 544px; grew because it's carrying more real functionality than the original mock, not because it's more cluttered — no scroll is needed at typical popup viewport heights and it's still 2 fewer cards than the shipped version).

Top to bottom:

1. **Header** — unchanged: title, status dot, gear → Settings.
2. **Download monitor** (conditional on an active batch) — unchanged content. Polish fix: "Clear monitor" used to be a full-width button stacked _above_ the card; it's now a small ghost "Clear" link inline with the `NN%` figure in the card's own header row, so a housekeeping action doesn't cost its own row.
3. **"On this page" card** — 4 actions, same hierarchy as shipped code: primary (filled) _Download + clear this page_, secondary (outline) _Download + clear, one by one_, tertiary (ghost) _Clear this page now (no download)_, destructive (red outline/wash) _Clear entire list (no download)_, disabled off list pages with a hint line. Active/Light mocks the disabled state; Idle/Dark mocks the enabled state, so between the two artboards both states are visible.
4. **"Behavior" card** — download-mode segmented control, divider, `Clear after download` toggle. When on (mocked in Idle/Dark), the `CLEAR FROM` sub-toggles (Bookmarks / Likes / For You) render inside a subtly indented, tinted sub-block rather than as flat sibling rows — this grouping treatment also carries over to the new Worklist & clearing Settings panel for visual consistency between the two surfaces.
5. **Harvest row** — new, minimal: single switch + "N,NNN tweets · Settings ›" link. No list, no export controls.
6. **Recent** — unchanged 3-item peek, conditional (Idle/Dark only, matching the original mock's split).
7. **Footer** — unchanged.

## Settings

### Sidebar fix (both `Settings · Light` `4:2` and `Settings · Dark` `5:2`)

The Figma sidebar only had 6 of the real 8 nav items. Added the missing two, in the code's actual order:

General → Downloads → **Filters** → Worklist & clearing → Cloud → **Knowledge Capture** → History → About

Also fixed a real bug spotted while doing this: in [`App.tsx`](../../../src/entrypoints/options/App.tsx) `SECTIONS`, **General and Filters both use `SlidersIcon`** — identical glyphs for two different nav items. Filters gets its own icon (a funnel, drawn fresh from an SVG path since no funnel glyph existed in the file yet); Knowledge Capture reuses the existing Layers icon vector (same one the popup already uses for that concept).

### New panel: Worklist & clearing (`Settings · Light — Worklist & clearing`, extends `4:2`'s shell)

One group, "Clear after download": header (icon + title + description), divider, the main toggle row, then the **4** conditional sub-toggles — Un-bookmark, Un-like, Not interested (For You), Clear from every list — inside the same indented/tinted `CLEAR FROM` sub-block treatment used in the popup mock. Trailing hint text matches [`worklist.tsx`](../../../src/entrypoints/options/panels/worklist.tsx) verbatim.

### New panel: Knowledge Capture (`Settings · Dark — Knowledge Capture`, extends `5:2`'s shell)

Two groups, matching [`capture.tsx`](../../../src/entrypoints/options/panels/capture.tsx):

- **Capture** — Harvest tweets / Capture everything scrolled / Mirror to Convex toggles (the latter two shown dependent/dimmed, matching the real disabled-until-parent-condition behavior).
- **Harvest** — tweet/conversation count badges + Refresh, a populated sample conversation list (handle + text + Export tree / Export Markdown per row, mocked with real-looking sample data rather than the empty state), then Export all (JSONL) + Clear harvest.

## Design tokens used (from [`src/app.css`](../../../src/app.css), no new tokens invented)

| Token                   | Value                                                       | Used for                                        |
| ----------------------- | ----------------------------------------------------------- | ----------------------------------------------- |
| `--xmd-accent`          | `oklch(0.58 0.176 250)` ≈ `#2D6FF6`                         | primary buttons, active nav, links (light)      |
| accent, dark variant    | `#6BA1FF` (existing file sample)                            | primary buttons, active nav (dark)              |
| `--xmd-danger`          | `oklch(0.58 0.19 28)` ≈ `#D33B33` (approximated — see note) | destructive "Clear entire list"                 |
| `--radius`              | `0.625rem` / 10px base                                      | buttons ~9–12px, cards 14–15px                  |
| Card fill/border/shadow | sampled directly from existing Figma nodes                  | all new cards match existing card style exactly |

**Note on the destructive red:** no destructive treatment existed anywhere in the original Figma file (the "Clear entire list" button is new this round), so its color was derived from `--xmd-danger`'s OKLCH value via manual conversion rather than sampled from an existing node. It's a close visual approximation, not pixel-exact — the shipped code already has the exact value via the CSS variable, so this only affects the mockup's fidelity, not the build.

## Open polish items (not blocking, noted for the build)

- `worklist.tsx`'s `SettingGroup` title ("Clear after download") and its first `Field` label repeat the same string — faithfully mirrored in the mock; worth a copy tweak during implementation but out of scope for this design pass.
- Switch thumb inset is a hair off-center in a few of the newly-drawn switches (cosmetic, Figma-only).

## Code implementation (next step, separate plan)

Not built yet. Follow-up `writing-plans` pass should cover:

1. **Popup** ([`App.tsx`](../../../src/entrypoints/popup/App.tsx)): remove the Knowledge Capture list/export card and the Local Data card; fold "Clear monitor" into the monitor card header; add the compact Harvest toggle row.
2. **Settings sidebar** ([`App.tsx`](../../../src/entrypoints/options/App.tsx)): add a distinct `FunnelIcon` to [`icons.tsx`](../../../src/components/icons.tsx) and point `Filters` at it instead of sharing `SlidersIcon` with `General`.
3. **Settings panels**: [`worklist.tsx`](../../../src/entrypoints/options/panels/worklist.tsx) and [`capture.tsx`](../../../src/entrypoints/options/panels/capture.tsx) already have the right functional content — this is a visual-grouping pass (indent/tint the `CLEAR FROM` sub-toggles) rather than new functionality.
4. No new settings/state, no new messages — purely UI reorganization plus the one icon addition.
