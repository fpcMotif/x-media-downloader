# R4 — Ground-up popup + settings redesign ("instrument, not dashboard")

**Date:** 2026-07-04
**Status:** Proposed — mockups only, no code touched
**Figma:** [X Media Downloader — Popup & Settings](https://www.figma.com/design/aPtze9cPET1OxKNN9hmVWG), new page **"R4 · Ground-up redesign"** (rounds 1–3 untouched on the Design page)
**Frames:** `49:3` Popup·Dark·Active · `49:45` Popup·Light·Idle · `50:2` Settings·Capture·Light · `52:2` Settings·Archive·Dark · `53:2` Foundations

## Why a restart

Rounds 1–3 polished a visual language that was never right: frosted cards on tinted washes, icon tiles in rounded squares, four stacked full-width buttons, flat 11–16px type. Competent shadcn-template grammar — and exactly what the product's own anti-references forbid ("noisy extension", "heavy dashboard", "sketchy downloader dressed as SaaS"). R4 replaces the language, not the information architecture: the round-3 IA (Clearing / Capture / Cloud + LIBRARY: Archive / History, popup as action surface) is already in code and stays.

## The idea: instrument, not dashboard

The popup is a cockpit instrument the user glances at while deep in X — dark, dense, flat, numbers first. Settings is a quiet typographic document read twice a month. Concretely:

1. **No cards.** Anywhere. Surfaces are flat; structure comes from hairlines (ink/white at 7–8%) and spacing. No nested boxes, no icon tiles, no gradient washes, no glass on these two surfaces (the on-page overlay keeps its liquid-glass identity — that's a different, on-content surface).
2. **Mono for every number.** Counts, sizes, speeds, percentages, dates, scope lists — all `ui-monospace` (mocked as Geist Mono), tabular. A downloader's soul is its numbers; giving data its own voice is the identity move. Text stays Inter/system-ui.
3. **One filled primary per surface.** Everything else is quiet: 6% fills or bare text. Destructive = red text, never a red slab.
4. **Popup is dark-first** (it floats over X, which is dark and media-heavy), light version proves the same structure in both themes.

## Popup (380px fixed; ~436px used of the 600px budget)

Top to bottom, hairline-separated, all one surface:

1. **Header** (44px): wordmark 13 SemiBold · status dot + "Ready on this X tab" right. No gear (Settings lives in the footer).
2. **Monitor** (only while a batch runs): `12 / 18` at 24px mono + "saved", `67%` mono accent right; 3px progress line; one mono meta line `4.2 MB/s · 6s left · 142 / 210 MB` + quiet "Clear". Replaces the round-1–3 244px monitor card (stat cells and log chips cut — the numbers carry it).
3. **Actions**: one 44px filled primary "Download + clear this page", then a 3-up row of 32px quiet buttons: "One by one" · "Clear page" · "Clear list…" (red text). Four stacked rows become two; the destructive slab is gone.
4. **State**: "Mode" + segmented (thumb 6 inside track 8 — concentric); "Clear after download" switch with mono scope line `Bookmarks · Likes` + "Edit ›"; "Capture tweets" switch with `2,156 tweets` + "Archive ›".
5. **Footer**: "No remote telemetry · local only" + "Settings".

**Cut from the popup:** the Recent list (duplicates Library → History; popup is an action surface) and the mode hint sentence (tooltip material). Idle state (light frame): action block at 45% opacity + one line "Works on Likes, Bookmarks, and list pages".

## Settings (typographic document)

- **Sidebar 220px, text-only** — no icons. Groups "Settings" / "Library" as 11px labels; items 13px; active = accent text on a 9% accent pill; About + "Appearance · System" in the bottom corner. (Was: 8 icon rows + brand tile + appearance card.)
- **Content column, 560–640px measure**: 20px title, 13px muted lede, then label/description rows with the control on the right, separated by hairlines. No SettingGroup cards, no icon tiles, no "off by default" copy in descriptions.
- **Capture panel** (light mock): three switch rows (master, everything-scrolled, Mirror-to-Convex with mono dependency note `Uses your Cloud connection` + "Cloud ›"), then an **Archive** section: `2,156 tweets · 2,117 conversations` in mono + "Open archive ›".
- **Archive page** (dark mock): search field + mono counts + Refresh in one toolbar row; conversation rows = mono @handle, muted snippet, mono `34 · Jul 2` meta, quiet "JSON · Markdown" links; "Show 50 more" + mono remainder; footer = quiet "Export all · JSONL" left, red "Clear archive…" far right.

## Foundations frame (the buildable spec)

Palette (light/dark hex pairs for surface, sidebar, ink, muted, faint, accent text, primary fill, danger, success), type scale (20 SemiBold → 11 mono meta), structure rules (concentric radii 12/10/8/6; one border **or** one shadow; hierarchy by quiet fills), and a motion table: press scale 0.97 · 160ms ease-out, switches 150ms, **no animation on popup open** (used constantly), saved-toast fade + 4px rise · 200ms, everything on the existing `--xmd-ease` `cubic-bezier(0.23, 1, 0.32, 1)`, reduced-motion = crossfade only, 40×40 minimum hit areas.

## Implementation notes (later, separate plan — no code in this round)

- Colors map onto the existing `--xmd-*` token system (same slots, new values); accent stays in the ~250° blue family so the on-page overlay still matches.
- Mono = `ui-monospace, 'SF Mono', Menlo, monospace` — nothing to ship.
- Popup: delete Card wrappers, wash divs, Recent section; the 600px scroll container gains ~160px of headroom.
- Settings: replace `SettingGroup` cards with section primitives; sidebar drops icons (icons.tsx keeps only functional glyphs).
- Panels not mocked (General, Downloads, Filters, Clearing, Cloud, History, About) follow the same row grammar mechanically; Cloud's provider blocks become two hairline sections instead of nested cards, connection identity shown as account email — never the raw `dbid`.

## Open questions

1. Dark-first popup regardless of OS theme, or keep following system? (Mock shows both hold.)
2. Keep the segmented Mode control in the popup, or demote to a mono summary line like the clear scopes?
3. Geist Mono as a bundled font vs. pure `ui-monospace` stack (mock uses Geist Mono; system mono is close enough to ship first).
