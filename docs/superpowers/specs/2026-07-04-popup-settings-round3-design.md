# Popup + Settings redesign (Figma round 3) — Capture/Archive split, nav regroup

**Date:** 2026-07-04
**Status:** Proposed — awaiting user review
**Figma file:** [X Media Downloader — Popup & Settings](https://www.figma.com/design/aPtze9cPET1OxKNN9hmVWG) (extended in place; round-2 frames untouched)
**New frames:** `Popup · Light · Round 3` (`36:2`), `Settings · Light — Capture (round 3)` (`38:2`), `Settings · Dark — Archive (round 3)` (`40:2`)

## Goal

Round 2 restored the "popup = action surface, Settings = config surface" split, but as shipped it left three taste problems on the table. This round is a pure regroup-and-polish pass, centered on where the tweet-harvest feature lives. No new functionality.

## The three problems in the shipped UI

1. **One feature, four names.** The sidebar says *Knowledge Capture*, the panel's first card says *Capture*, its second card says *Harvest*, and the popup toggle says *Harvest tweets*. A user cannot form one mental model from four labels.
2. **A data browser is living inside a config surface.** The "Harvest" card (counts, conversation list, per-row exports, clear) is content management, not a setting. As the archive grows past a few thousand tweets, a 3-row peek with two outline buttons per row does not scale, and it buries the feature's actual value (a searchable local archive) at the bottom of a settings panel.
3. **The popup needed an apology.** "These set what the buttons above do — they don't download on their own" is copy compensating for grouping: config depth (three CLEAR FROM sub-switches) and two full-width clear buttons (one a big destructive slab) crowd the action surface. Chrome caps popups at 600px, so every row that isn't an action pushes real actions below the fold.

## Decisions

### 1. Naming: **Capture** is the verb, **Archive** is the noun

- The settings surface (toggles) is called **Capture** everywhere: sidebar item, panel title, popup row ("Capture tweets").
- The data surface (what got captured) is called **Archive**: its own page, linked from both the Capture panel and the popup.
- "Knowledge Capture" and "Harvest" disappear from the UI. Plain nouns fit the restrained/trustworthy brand voice; "Knowledge Capture" reads as enterprise-KM marketing.

### 2. Sidebar regroups into SETTINGS + LIBRARY

```
SETTINGS          LIBRARY         (bottom utility)
  General           Archive         Appearance
  Downloads         History         About
  Filters
  Clearing
  Capture
  Cloud
```

- **LIBRARY** is the new group for data surfaces. History (download records) was already a data page wearing a settings costume; Archive joins it, and the split makes both legible.
- **Worklist & clearing → Clearing.** The panel is entirely about clear-after-download; the shorter label matches its siblings.
- **Capture sits next to Cloud** because Mirror-to-Convex depends on the Cloud connection.
- **About** leaves the nav list for the sidebar's bottom utility corner, next to Appearance — it is not a setting.

### 3. Knowledge Capture placement: split config from content

- **Capture panel** (`38:2`, light): one group card. The master **Capture tweets** switch lives in the card header itself (title + description + switch), killing the round-2 title/label duplication. Below a divider, a tinted **WHILE CAPTURING** sub-block (same treatment as the popup's CLEAR FROM in round 2) holds the two dependents: *Everything you scroll* and *Mirror to Convex* (description points at the Cloud connection). A slim **Archive link card** below ("Archive — 2,156 tweets · 2,117 conversations on this device · Open ›") cross-links the data surface.
- **Archive page** (`40:2`, dark): a real data surface. Toolbar = search field ("Search handles and text") + counts + Refresh, right-aligned. Conversation list with per-row meta ("34 tweets · Jul 2") and quiet text-link exports (**Tree · Markdown**) replacing round 2's two outline buttons per row. Footer = **Export all (JSONL)** outline button left, **Clear archive…** as a quiet red text button pushed to the far right — destructive action separated, not enlarged.
- Search is new-but-cheap: the capture DB already indexes conversations; a handle/text filter is a pure-core function. If it gets cut, the toolbar still works with counts + Refresh only.

### 4. Popup regroup (`36:2`, light)

Top to bottom (monitor and header unchanged from round 2):

1. **On this page** — two download actions keep their weight (filled primary *Download + clear this page*, outline *Download + clear, one by one*). The two no-download clears collapse into one quiet row under a `CLEAR WITHOUT DOWNLOADING` kicker: **This page** (muted quiet button) and **Entire list…** (red-text quiet button, ellipsis signalling the confirm). The destructive slab is gone; the rarely-used dangerous action no longer owns a full-width row of prime popup space.
2. **Behavior** — the apology sentence is deleted. `DOWNLOAD MODE` segmented control stays (it genuinely changes what the buttons do and the user flips it). *Clear after download* keeps its switch, but the three CLEAR FROM sub-switches are replaced by a one-line summary link: **From Bookmarks & Likes · Clearing ›** — state is visible, config depth lives in Settings.
3. **Capture row** — "Capture tweets" switch + "2,156 tweets · Archive ›" link (was "Harvest tweets · Settings ›").

Net effect: same capabilities, ~2 button rows + 3 sub-switch rows shorter, no explainer copy, and the fold (600px) now lands below the behavior card instead of inside it.

## Also fixed while in the file

- Round 2's `Settings · Dark — Knowledge Capture` frame (`30:2`) had Cloud's lede ("Back up to your own cloud…") pasted as the page description — the round-3 frames carry their own correct ledes.
- Round-2's popup mock truncated the Clear-after-download description mid-sentence; round 3 shortens it to one line ("Un-like / un-bookmark each post as its media lands").

## Out of scope, noted for a later round

- **Cloud panel**: nested provider cards (Google Drive / Dropbox boxes inside the Cloud upload card) and the raw `dbid:…` leaking as the Dropbox connection badge. Both worth a pass of their own.
- Dark popup / light Archive theme pairs (round-3 frames follow the round-2 one-mock-per-theme convention).
- Any Convex/messaging changes: none are needed; this is UI reorganization.

## Code implementation (separate plan, after review)

1. **Sidebar** ([`options/App.tsx`](../../../src/entrypoints/options/App.tsx)): section groups (SETTINGS / LIBRARY), renames (`Worklist & clearing → Clearing`, `Knowledge Capture → Capture`), new `archive` section, About moved to the bottom utility area, an ArchiveIcon added to [`icons.tsx`](../../../src/components/icons.tsx).
2. **Split [`capture.tsx`](../../../src/entrypoints/options/panels/capture.tsx)** into `capture.tsx` (toggles + archive link card; master switch in the `SettingGroup` header — small `SettingGroup` extension for a header-slot action) and `archive.tsx` (toolbar + list + exports + clear; search filter over the existing capture summary, or counts-only if search is cut).
3. **Popup** ([`popup/App.tsx`](../../../src/entrypoints/popup/App.tsx)): replace the two full-width clear buttons with the quiet two-button row, drop the explainer sentence and `CLEAR FROM` sub-switches for the summary link (deep-link `#worklist`→`#clearing`), rename the capture row, deep-link `#archive`.
4. Copy updates per this spec; no settings schema or message changes.

## Open questions for review

1. **"Capture" vs "Tweet Capture" vs keeping "Knowledge Capture"** as the sidebar label — round 3 assumes plain **Capture**.
2. **Search in v1 of the Archive page** — mocked; cuttable without relayout.
3. **Popup DOWNLOAD MODE segmented control** — kept on the theory it's flipped often (Direct/aria2). If it's actually rare, it could become a summary line like the clear scopes and the popup shrinks another ~70px.
