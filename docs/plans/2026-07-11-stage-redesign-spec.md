# Redesign Spec — Popup + Settings ("Stage" direction, final)

**Status:** DEFINITIVE. Implementers must not invent copy, spacing, or behavior — everything is here.
**Repo:** `/Users/martinfan/devv/xediadownloader` (read-only during spec authoring; implementation edits the files listed in §5).
**Sources synthesized:** Stage brief (winner, 2/3 judge votes) + Three Verbs brief (verb system, Confirm Strip) + grafts locked by the user + 17 confirmed audit findings on popup/options files + repo ground truth as of 2026-07-11.

**Hard constraints honored throughout:** settings schema + message contracts FROZEN (`src/core/settings`, `src/core/schema` untouched; UI reads existing fields only). No new runtime deps. Preact + Tailwind v4 + vendored ui components + `--xmd-*` tokens. Light+dark, WCAG AA, ≥40px targets everywhere in popup/options, `outline-none focus-visible:ring-3 focus-visible:ring-ring/50` on every interactive element, no `transition-all`, `tabular-nums` on all dynamic numbers, `text-balance`/`text-pretty` where apt, reduced-motion respected, **no native `confirm()` anywhere**, content-driven popup height (min 360 / max 600), restrained instrument register per PRODUCT.md.

**Concurrent-workflow boundary (do not violate):** another workflow is currently fixing `src/components/ui/button.tsx`, `select.tsx`, `switch.tsx`, `toggle.tsx`, `toggle-group.tsx`, `progress.tsx` and the `--xmd-accent` tokens in `src/app.css`. This spec is written against their **post-fix** behavior, already observable in the tree: explicit transition property lists, `active:scale-[0.97]` toggle press feedback, Switch `after:-inset-y-3` (42px hit slop), `--xmd-accent: oklch(0.50 0.176 250)` light / hover `0.44`, dark filled-control foreground = ink, `toggle-group.tsx` now emitting `data-horizontal`. **No batch in §7 may edit `src/components/ui/*`.** The only `src/app.css` edits allowed here are the popup frame rules (§2.9) — nothing in the token blocks.

---

## 1. Design contract (10 lines)

1. **Direction — Stage:** the popup answers "what can I do here, right now" first. Zone 1 states the tab context; Zone 2 (Stage) holds only the actions that apply to that context; everything below is ambient standing state.
2. **Inapplicable controls are never rendered, never dimmed** — an IG tab shows hover-grab teaching, not disabled X buttons. Sole carve-out: global settings (Mode, toggles) stay visible on every tab because they are tab-independent.
3. **Three verbs, three consequence tiers, never shared:** **Reset** (Tier 0, harmless UI state — monitor), **Erase** (Tier 1, local data wipe — archive/history), **Release** (Tier 2, X-account mutation — un-like/un-bookmark; the only tier that touches the account). The bare word "Clear" is retired from every user-facing surface.
4. **Confirm buttons restate the literal action** — "Release the list", "Erase the archive", "Turn it on". The word "Confirm" alone never appears on a button.
5. **One typed-word gate in the whole product:** whole-list release types `RELEASE`. Standing rule: **no keyboard accelerator (accesskey/shortcut) is ever bound to a destructive action**, and Enter alone can never fire the typed-word gate.
6. **Auto-release is confirmed once, at toggle-on time** (Confirm Strip on the switch), then becomes a *standing visual state* (red-dot status line under the CTA + "On" state line in Settings) — never a per-download interruption.
7. **Download-shaped actions and release-only actions never share a row or a shape:** downloads are filled/quiet rectangles; releases are red text-rows in their own hairline-separated cluster.
8. **Feedback is zone-scoped:** the download cluster, release cluster, and capture cluster each own a status line; a result can never overwrite an unrelated cluster's message. The green "Saved" toast is reserved exclusively for settings-field autosave.
9. **Register:** restrained instrument — flat surfaces, hairlines not cards, 13px body / 11px eyebrows, `--xmd-ease` everywhere, nothing over 220ms, no bounce, no gradients, no glass, counts in `font-mono tabular-nums`.
10. **Height is honest:** the popup renders its content's height (min 360, max 600, scroll beyond) — an idle instrument doesn't cast a 600px shadow.

---

## 2. Popup

### 2.0 Component tree

```
src/entrypoints/popup/
  App.tsx                     — frame, state, zone composition
  context.ts        (NEW)     — pure: TabContext derivation + labels (testable)
  first-run.ts      (NEW)     — chrome.storage.local intro counter (outside Settings schema)
  capture-quick-actions.tsx   — rebuilt: Recent disclosure + Erase archive via ConfirmStrip
  history-section.ts          — historyEmptyLabel reword + confirmEraseHistoryCopy helper
src/components/
  confirm-strip.tsx (NEW)     — shared arm→confirm component (popup + options)
  confirm-strip-logic.ts (NEW)— pure helpers: guard window, typed-word match, disarm timing
  action-copy.ts    (NEW)     — every verb label + confirm/consequence sentence (single source)
  capture-copy.ts             — plural/fmtDay + Erase-archive copy (verb-swapped)
```

App component tree (render order top→bottom):

```
<div class="xmd-popup">
  <ContextStrip />                       // zone 1 — always
  {monitor && <MonitorZone />}           // zone 2 — only while a batch is live
  <StageZone />                          // zone 3 — per tab context (§2.2)
  {ctx is 'x' | 'x-list' && <ReleaseCluster />}   // zone 4 — X only, never rendered elsewhere
  <PreferencesZone />                    // zone 5 — Mode + 2 toggles (global; rows suppressed per platform)
  <CaptureQuickActions />                // zone 6 — renders null until something captured
  <Footer />                             // zone 7 — always
  <SavedToast />                         // fixed, settings-autosave only
</div>
```

### 2.1 Frame + zones (px)

Width **380px** fixed (unchanged). Height **content-driven**: `min-height: 360px`, `max-height: 600px`, `overflow-y: auto` past the cap (Chrome caps action popups at 600×800; we stay at 380×≤600). See §2.9 for the exact `app.css` diff. Height changes between popup opens are NOT animated (Chrome owns the window resize; animating content height on top of it double-animates — a deliberate non-motion).

Zone boundaries: every zone is separated by the same rule — `border-t border-border` hairline (the existing `--xmd-line` token via `--border`) with `px-3.5` horizontal padding, replacing today's mixed `border-b`/`border-t`/none. Zone paddings snap to the 8/12/16 rhythm: `py-3` (12px) for strips, `py-4` (16px) for content zones.

| Zone | Height | Notes |
|---|---|---|
| 1 Context strip | 36px (`h-9`) | text + readiness dot; no wordmark (the user just clicked an icon labeled "X Media Downloader"; Settings sidebar keeps the wordmark) |
| 1b First-run strip | 44px when shown | teaching line + 40×40 dismiss `×` button |
| 2 Monitor | ~96px when live | internals unchanged; button renamed **Reset** |
| 3 Stage | 44–140px per context | see matrix |
| 4 Release cluster | 40px collapsed / ~100–148px expanded | X tabs only |
| 5 Preferences | ~150px (Mode 40 + eyebrow + 2 field rows) | rows suppressed per platform, never dimmed |
| 6 Recent captures | 40px disclosure / +var expanded | null until `tweets > 0` |
| 7 Footer | 44px | privacy line + Settings link |

Approximate totals (content-driven proof): X list idle ≈ 520px · X non-list ≈ 470px · IG/Threads ≈ 400px · unsupported ≈ 420px · floor 360px. All under the 600 cap without scrolling; monitor + expanded Recent may scroll — acceptable.

### 2.2 Tab-context state matrix

`TabContext` is derived in `context.ts` (pure, unit-tested):

```ts
export type TabContext = 'x-list' | 'x' | 'instagram' | 'threads' | 'none'
// x-list  = adapterForUrl(url)?.platform === 'x' && Option.isSome(pageScope(pathname))
// x       = platform 'x', not a list page
// instagram / threads = adapter platform
// none    = no adapter (unsupported tab, or tabs.query failed)
```

| Zone | `x-list` | `x` | `instagram` / `threads` | `none` (unsupported) |
|---|---|---|---|---|
| Context strip | `X · Bookmarks list` / `X · Likes list` (dot green) | `X · ready` (green) | `Instagram · ready` / `Threads · ready` (green) | `Not on X, Instagram, or Threads` (gray dot) |
| Stage | CTA `Download this page` (h-11, filled primary) + `One by one` (h-10, quiet) + download status line + standing auto-release line when on | same as x-list | teaching rows (no buttons — drain/sweep don't exist here): hover-grab + whole-post + dock copy (§2.3) | teach-and-route: headline + three 40px link-rows opening x.com / instagram.com / threads.net |
| Release cluster | **rendered expanded** (power context): eyebrow + `Release this page…` + `Release the whole list…` + release status line | rendered **collapsed** as a 40px disclosure row `Release ›`; expanding reveals `Release this page…` only (whole-list is inapplicable off-list → **not rendered**, no tooltip-disabled ghost) | **not rendered** | **not rendered** |
| Preferences | Mode + Release-after-download row + Capture row | same | Mode only + one note row: `Release and Capture are X-only.` | all three rows (global settings remain reachable — the carve-out) |
| Recent captures | as data dictates | same | **not rendered** (capture is X-only) | as data dictates |
| Footer | always | always | always | always |

**First-run overlay state** (orthogonal, X contexts only): while `first-run` is undismissed, the first-run strip renders between Context strip and Monitor/Stage. Dismissal (whichever first): user clicks `×`; any Stage action completes successfully once; popup has been opened 3 times. Tracked in `first-run.ts` via `storage.defineItem('local:xmd-popup-intro', { fallback: { opens: 0, done: false } })` — the same `local:` idiom `filters.tsx` already uses for `local:daily-budget`; **not** a Settings-schema field; owned entirely by popup code.

**Active-batch state** (orthogonal): when `metrics.total > 0`, MonitorZone mounts above Stage. Stage's buttons **stay enabled** — a second drain/sweep mid-batch is a legitimate power-user pattern (this deliberately overrides the Stage brief's button-suppression, which judge 1 flagged as its one real flaw). The Monitor is the *only* progress surface; Stage never renders its own progress bar, so the two-progress-surfaces problem cannot occur. The button that fired the in-flight request shows its busy label (`Queuing…` / `Sweeping…`) only while its `sendMessage` round-trip is pending, exactly as today.

**Loading state:** `.xmd-popup--loading` gets `min-height: 360px` (was 120px) so the frame doesn't jump on hydrate.

### 2.3 Copy deck (exhaustive — implementers copy verbatim)

All strings live in `src/components/action-copy.ts` unless marked [inline] or already owned by an existing module. `{mod}` = the quick-grab modifier display name derived from `settings.quickGrabModifier` (same mapping general.tsx uses: alt→`Alt`, shift→`Shift`, ctrl→`Control`, meta→`Cmd`); `{mod2}` = the whole-post second key (`Cmd` when modifier is alt, `Alt` when modifier is meta — mirror of general.tsx line 44).

**Context strip**
- `X · Bookmarks list` · `X · Likes list` (from `pageScope`; if scope is Some but names neither, fall back to `X · list page`)
- `X · ready`
- `Instagram · ready` · `Threads · ready`
- `Not on X, Instagram, or Threads`

**First-run strip**
- Body: `Hover a photo or video and hold {mod} to grab it. The buttons below handle the whole page.`
- Dismiss button: `×` with `aria-label="Dismiss tip"`

**Stage — X contexts**
- CTA idle: `Download this page`
- CTA when auto-release standing state is on (willClear): `Download + release this page`
- CTA busy: `Queuing…`
- Standing auto-release line (only when `willClear`; 11px, `text-muted-foreground`, with an inline `size-1.5 rounded-full bg-destructive` dot): `Release after download is on`
- aria2 caveat line (when `clearOnSave && downloadStrategy === 'aria2'`): `aria2 hand-offs can't be verified — posts download but aren't released (use Direct or Fetched).`
- Secondary: `One by one` · busy: `Sweeping…`

**Stage — download status line** (cluster-scoped; formats keep today's shapes, verb-swapped)
- Drain, n=0: `No media detected yet — scroll to load posts, then try again.`
- Drain, releasing: `Downloading {n} items — each post releases as it finishes.`
- Drain, plain: `Downloading {n} items.`
- Sweep, not-list: `Open a Likes or Bookmarks page — the sweep only runs on a list.`
- Sweep, stale context: `Reload the X tab (the extension was updated), then try again.`
- Sweep, nothing new: `No new media detected — scroll to load posts, then run again.`
- Sweep, releasing: `Queued {n} posts, skipped {s} already released. Each releases from this list as its download finishes — scroll and run again.` (skipped clause only when s > 0)
- Sweep, plain: `Queued {n} posts for download. Turn on "Release after download" below to also remove each from this list.`
- Unreachable (any page action): `Could not reach the page — reload the X tab and try again.`
- No tab: `No active tab.`
- (`{n} items`/`{n} posts` via `plural()` from `@/components/capture-copy` — App.tsx's local duplicate is deleted, closing the capture-copy handoff's step 5.)

**Stage — IG/Threads teaching** [two lines, 13px, `text-pretty`]
- `Hover a photo or video and hold {mod} to grab it.`
- `Hold {mod} + {mod2} to grab a whole post, or use the download dock.`

**Stage — unsupported (teach-and-route)**
- Headline (13px medium, `text-balance`): `Open X, Instagram, or Threads to use this extension.`
- Route rows (each a 40px `min-h-10` full-width row, quiet hover `hover:bg-muted`, opens a new tab via `browser.tabs.create`): `x.com ›` · `instagram.com ›` · `threads.net ›`

**Release cluster**
- Eyebrow (11px semibold tracking-wide muted): `Release without downloading`
- Collapsed disclosure row (non-list X tabs): `Release ›` / expanded chevron `⌃`
- Row 1 trigger (red text, `text-destructive`, ellipsis = opens Confirm Strip): `Release this page…`
- Row 1 armed sentence: `Release every post on this page — un-like on Likes, un-bookmark on Bookmarks. This can't be undone.`
- Row 1 buttons: `Cancel` / **`Release this page`**
- Row 1 result: `Released {n} posts on this page.`
- Row 2 trigger (list pages only): `Release the whole list…`
- Row 2 armed sentence: `Release the whole list — scrolls the entire list and releases every post. This can affect hundreds of posts and can't be undone.`
- Row 2 typed-word field label: `Type RELEASE to continue`
- Row 2 buttons: `Cancel` / **`Release the list`**
- Row 2 results: not-list `Open a Likes or Bookmarks list to release it.` · zero `No posts to release on this list.` · n `Released {n} posts across the list.`

**Preferences zone**
- Eyebrow: `Mode` (unchanged; segments Direct / Fetched / aria2 with their existing `DOWNLOAD_MODES` hints as `title`)
- Release-after-download row label: `Release after download` (this string moves into `CLEAR_AFTER_DOWNLOAD.label` in `src/core/clear/copy.ts` — the existing shared-copy module; description becomes `Remove each saved post from its list once its media truly lands.`)
- Row description when ON (mono scope summary, unchanged mechanism): `Bookmarks · Likes · For You · Edit ›` (scopes from `clearScopeSummary`; `Edit ›` deep-links `#release`)
- Row description when OFF: the `CLEAR_AFTER_DOWNLOAD.description` string above
- Toggle-ON Confirm Strip sentence: `Turn on release after download? Each saved post will also be removed from its list (un-like on Likes, un-bookmark on Bookmarks) once its media is verified saved.`
- Toggle-ON buttons: `Cancel` / **`Turn it on`** (250ms guard preset; toggling OFF never confirms)
- Capture row label: `Capture tweets`
- Capture description, toggle OFF: `Off — captures tweet text locally as you scroll.` (no count shown — fixes the dishonest permanent `0 tweets`)
- Capture description, ON + 0 captured: `Capturing — nothing saved yet`
- Capture description, ON + n: `{n} tweets` (mono tabular-nums) + link `Archive ›` (deep-links `#capture`)
- IG/Threads note row (replaces the two suppressed rows): `Release and Capture are X-only.`

**Monitor zone** (internals unchanged except the verb)
- Count readout: `{done}/{total}` + word `saved` · percent `{p}%` (all `font-mono tabular-nums`)
- Button: `Reset` · while `active > 0`: `Active` (disabled, `title="Downloads still active"`). The `clearFeedback`/"Cleared" flash state is **deleted** — on success the monitor unmounts immediately, so the flash was never visible; remove the dead state.
- Meta line: unchanged composition (`fmtRate` · `{n}s left` · `bytes/bytes` · `{n} faileds`→ keep `plural(n,'failed')` and `plural(n,'retry')` as today)

**Recent captures (CaptureQuickActions)**
- Disclosure: `Recent` + `⌄`/`⌃`
- Row: `@{handle}` · `{n} tweets` · `{Mon D}` · links `JSON` · `Markdown` · second line root text (all unchanged)
- Empty (open, none): `Nothing captured yet.`
- Bulk: `Export all · JSONL`
- Erase trigger (red): `Erase archive…`
- Erase armed sentence (`confirmEraseArchiveCopy(n)` in capture-copy.ts): `Erase all {n} captured tweets? This cannot be undone.`
- Erase buttons: `Cancel` / **`Erase the archive`**
- Erase result (`erasedArchiveCopy(n)`): `Erased {n} tweets from the archive.`
- Export result strings: unchanged (owned by `capture-export.ts`)

**Footer** (unchanged)
- `No remote telemetry · local only` / `Cloud sync on · metadata only`
- Link: `Settings`

**Saved toast** (settings autosave only): `Saved` + check icon (unchanged copy).

### 2.4 Confirm Strip — interaction spec

One shared component, `src/components/confirm-strip.tsx`, used by: Release this page, Release the whole list (typed-word variant), Erase archive (popup + options), Erase history (options), Release-after-download toggle-ON (popup + options). It replaces **all** `confirm()` calls; after this redesign `rg -n "confirm\(" src/entrypoints` must return zero hits (the `usePageAction` `confirm?` option is deleted).

**Anatomy (armed):** the trigger's row transforms in place into a strip (`rounded-[var(--xmd-radius-3)]`, `bg-destructive/8` for Release/Erase tiers, `bg-muted` for the toggle-ON tier, `p-3`, `grid gap-2`):
1. Consequence sentence (13px, `text-pretty`; `text-destructive` for tier-1/2, `text-foreground` for toggle-ON).
2. (typed-word variant only) labeled `<Input>` — see §2.5.
3. Button row, right-aligned: `Cancel` (quiet, h-10, `hover:bg-muted`) then the **literal-action confirm button** (h-10, `bg-destructive/10 text-destructive hover:bg-destructive/20` for tier-1/2; `bg-primary text-primary-foreground` for toggle-ON). Both `min-w-[96px]`.

**Mouse path:**
1. Click trigger → strip arms (label→strip crossfade 180ms `--xmd-ease`).
2. Guard window: the confirm button renders **inert** — `pointer-events-none` + `aria-disabled="true"` + opacity easing 40%→100% across the window. Presets: **450ms** for one-shot destructive triggers (Release page/list, Erase archive/history); **250ms** for the settings-precommitted toggle-ON confirm. This defeats the double-click-lands-on-confirm failure; the windows are pointer lockouts, NOT animation durations, and are exempt from `prefers-reduced-motion` (safety, not decoration).
3. Click confirm → fires the existing message (`ClearVisibleRequest` / `ClearWholeListRequest` / `ClearCaptureRequest` / `ClearHistoryRequest` / the `update({clearOnSave:true})` write). The strip only gates *when* a message sends, never *what* — zero contract changes.
4. Click Cancel, or click anywhere outside the strip (after a 300ms grace so reading-position clicks don't insta-cancel) → disarm, revert to trigger.
5. Auto-disarm after **8s** idle; the last 2s show a thin (2px) shrinking underline across the strip bottom (`bg-destructive/40`) so the revert isn't a surprise. Reduced motion: no underline animation; the strip simply reverts at 8s.

**Keyboard path:**
- Trigger is a normal button: Enter/Space arms.
- On arm, **focus moves to Cancel** — repeating the arming keystroke cancels, never confirms. Tab order inside the strip: Cancel → (typed-word input) → Confirm. No focus trap; Escape anywhere inside the strip disarms and **returns focus to the original trigger**.
- Confirm fires on Enter/Space only while focused *and* past the guard window *and* (typed-word variant) the word matches.
- `aria-live="polite"` region announces on arm: `Press {confirm label} to continue, or Cancel.`
- **No `accesskey` attribute may appear anywhere in popup/options source** (standing rule; pinned by test §6).

**Arbitration:** one armed strip per surface. Arming any strip disarms any other (module-level registry in `confirm-strip.tsx`: `let disarmCurrent: (() => void) | null`).

**Timing summary:** arm crossfade 180ms · guard 450/250ms · outside-click grace 300ms · auto-disarm 8000ms (underline from 6000ms). All pure timing math lives in `confirm-strip-logic.ts` (`guardElapsed`, `disarmDeadline`, `typedWordSatisfied`) so it is unit-testable without DOM.

### 2.5 Typed-word gate (whole-list release only)

- Appears only in the `Release the whole list…` strip — the single most destructive control in the product. No other action may adopt it without a new design round.
- `<Input>` (vendored, h-8 is fine — the input is not a pointer *target* requiring 40px, but give the row `min-h-10` alignment) with visible label `Type RELEASE to continue`, `autocomplete="off"`, `spellcheck={false}`, `autofocus` NOT set (focus lands on Cancel per §2.4; the user tabs into the input deliberately).
- Match rule (`typedWordSatisfied(value)` in confirm-strip-logic.ts): `value.trim().toLowerCase() === 'release'`. Word constant `RELEASE_WORD = 'RELEASE'` exported from `action-copy.ts`.
- The confirm button (`Release the list`) stays `aria-disabled` + inert until BOTH the guard window has elapsed AND the word matches.
- **Enter inside the input is inert** (`onKeyDown`: `if (key === 'Enter') preventDefault()`) — it neither submits nor moves focus. Firing requires an explicit activation of the confirm button (click, or Tab-to-it + Enter/Space). This is the "typed-word gate cannot fire on Enter alone" safety property, pinned by test (§6).
- Escape in the input disarms the strip (same as anywhere in the strip).
- On disarm/cancel the input value is discarded; re-arming starts empty.

### 2.6 Feedback / status model

Three cluster-scoped status lines replace today's single `actionMsg`:

| Cluster | State slot | Written by | Placement |
|---|---|---|---|
| Download | `downloadMsg` | drain, sweep | directly under the One-by-one row |
| Release | `releaseMsg` | release-page, release-list | directly under the release rows |
| Capture | `statusMsg` (existing) | exports, erase archive | inside CaptureQuickActions (unchanged slot) |

Lifecycle (uniform): set on completion; `aria-live="polite"`; auto-clears after **6s** — **except** actionable errors (unreachable-page, stale-context, no-active-tab), which persist until the next action *in that same cluster* starts. Starting an action clears its own cluster's line immediately (today's behavior, kept). `usePageAction` keeps its shape but: the `confirm?: string` option is **removed** (gating now happens in the JSX via ConfirmStrip before `run()` is invoked), and it gains a `kind: 'download' | 'release'` only insofar as callers pass the right `setMsg` — no other change.

The settings **Saved toast** is reserved for `update()` writes only. Destructive completions never use it (a green "Saved" after an Erase reads as "something was added").

### 2.7 Motion spec

- Curve: `--xmd-ease` (`cubic-bezier(0.23,1,0.32,1)`) everywhere; expressed in Tailwind as `ease-[var(--xmd-ease)]` where a utility needs it.
- **120ms** — color/opacity micro-transitions (hover text/underline color on text-links).
- **160ms** — press/hover on buttons + switch (already pinned by `app.css` `[data-slot='button']` / `[data-slot='switch']`; every hand-rolled button therefore carries `data-slot="button"` — audit findings 3/4).
- **180ms** — Confirm Strip label↔strip crossfade (opacity only).
- **200ms enter / 150ms exit** — Saved toast, scoped: `transition-[opacity,transform] ease-[var(--xmd-ease)]` + `saved ? 'translate-y-0 opacity-100 duration-200' : 'translate-y-1 opacity-0 duration-150'` — identical classes in popup and options (fixes findings 5, 13, 16; both surfaces standardize on `translate-y-1` = 4px rise per the R4 motion table).
- **220ms** — structural mounts (monitor, first-run strip, disclosure expand): opacity + 4px translate on mount only. **No height tweening** — height snaps (the browser lays out; we don't fight it).
- **Never animates:** popup width; count/text deltas (numbers jump, `tabular-nums` keeps them steady); Chrome's own window resize; disabled-state flips beyond the standard 160ms; the Progress bar beyond its own `transition-transform`.
- Guard windows (450/250ms) are lockouts, not animations — implemented with timestamps in `confirm-strip-logic.ts`, NOT CSS transitions, so `prefers-reduced-motion` (which zeroes transition durations globally via the existing `app.css` block) cannot shorten them.
- `transition-all` count in popup/options source after this redesign: **0** (pinned by test).

### 2.8 Hit targets + focus (popup-wide rules)

- Every interactive element ≥40px effective target: CTA h-11; One-by-one h-10; release rows/disclosures `min-h-10`; Mode `ToggleGroupItem` **h-10** (finding 2); route rows `min-h-10`; footer `Settings` link and the `Edit ›`/`Archive ›` text-links get invisible slop `relative after:absolute after:-inset-y-3 after:-inset-x-1` (18px text + 24px = 42px, matching the Switch idiom); monitor `Reset` gets `min-h-10 px-2 -my-3` (visual footprint unchanged — finding 7); CaptureQuickActions rows: disclosure `min-h-10`, per-row `JSON`/`Markdown`/`Export all`/`Erase archive…` links get the same after-slop treatment.
- Every interactive element carries `outline-none focus-visible:ring-3 focus-visible:ring-ring/50` (text-links additionally `rounded-sm` so the ring hugs the text) — finding 15.
- Every hand-rolled `<button>` carries `data-slot="button"` + `transition-colors active:scale-[0.97]` (popup convention; findings 3/4). Options text-links get the ring but **skip** `active:scale` (per the adjudicated archive finding — scaling plain underlined text on a full page looks broken; the popup's compact links keep it for consistency with their established convention).
- Mode ToggleGroup: wrapper keeps `rounded-[var(--xmd-radius-3)]` and adds `style={{ '--radius': 'var(--xmd-radius-3)' }}`; the per-item `rounded-[var(--xmd-radius-4)]` class is **dropped** (dead in the cascade). Now that the concurrent ui-fix emits `data-horizontal`, the vendored first/last `rounded-l-lg`/`rounded-r-lg` rules fire and resolve to the overridden 8px; middle segment correctly `rounded-none` (finding 6, adjusted-fix path).

### 2.9 Height behavior — `app.css` + `index.html` diff

`src/app.css` (popup frame rules only; token blocks untouched):

```css
html, body, #app {
  width: 380px;
  min-width: 380px;
  margin: 0;
  background: var(--xmd-bg);
}
/* height pins removed: no height/min-height/max-height/overflow-hidden here */

.xmd-popup {
  width: min(380px, 100vw);
  min-height: 360px;
  max-height: 600px;   /* Chrome caps action popups at 600×800 */
  overflow-y: auto;
  /* rest unchanged: background, color, font stack */
}

.xmd-popup--loading {
  min-height: 360px;   /* was 120px — prevents hydrate jump */
  display: grid;
  place-items: center;
  color: var(--xmd-muted);
}
```

`src/entrypoints/popup/index.html`: the inline boot-fallback style block mirrors the same change (`min-height: 360px`, no fixed 600) so the pre-hydrate frame matches. `popup-layout.test.ts` assertions change accordingly (§6).

---

## 3. Settings (options page)

### 3.1 Nav model

Shell unchanged: 220px sticky sidebar, two labeled groups + bottom utility corner, `Section`/`PanelHeader` primitives from `ui.tsx`, `history.replaceState` hash sync, hash-on-mount + `hashchange` listener. What changes is the grouping (9 sections → 5 task clusters + 2 library + About) and the alias mechanism.

**New `SECTIONS` (options/App.tsx):**

```ts
const SECTIONS = [
  { id: 'saving',  label: 'Saving',  group: 'settings', Panel: SavingPanel },
  { id: 'release', label: 'Release', group: 'settings', Panel: ReleasePanel },
  { id: 'capture', label: 'Capture', group: 'settings', Panel: CapturePanel },
  { id: 'sync',    label: 'Sync',    group: 'settings', Panel: SyncPanel },
  { id: 'archive', label: 'Archive', group: 'library',  Panel: ArchivePanel },
  { id: 'history', label: 'History', group: 'library',  Panel: HistoryPanel },
  { id: 'about',   label: 'About',   group: 'utility',  Panel: AboutPanel },
] as const satisfies ReadonlyArray<Section>
```

**Justification (the user delegated the final clustering call):** General + Downloads + Filters all answer one question — "how does media get onto my disk" — so they merge into **Saving** (matches PRODUCT.md's own framing: "download one item or a whole detected set … keep Downloads organized"). This is the biggest IA change of the round; the cost (one long scrollable page, 8 hairline sections) is acceptable in the R4 flat-document register where sections are typographic, not boxed, and it shrinks the Settings nav from 6 items to 4 — each now a task, not a feature noun. **Release** (was Clearing) takes the tier-2 verb. **Capture** keeps its name (already a task). **Cloud → Sync** names what the user is doing, not the technology. Library and About are untouched structurally. Nouns, not gerunds ("Saving" reads as the noun phrase "saving [media]"), keeping labels one word each.

**Sidebar chrome deltas:**
- The dead `Appearance · System` span (App.tsx:167) is **deleted** from the sidebar. Its information relocates to the About panel (§3.5). `settings.theme` exists in the frozen schema but has no runtime plumbing — this spec deliberately does **not** wire a theme control (shipping a switch that does nothing is worse than honest prose; out of scope by locked decision).
- A small red tier tag sits inline after the **Release** nav label and the Release panel `<h1>`: `<Badge variant="destructive" className="ml-1.5">Account</Badge>` — the danger tier is legible from the sidebar before the user clicks in.
- All three `rounded-[8px]` literals in App.tsx (toast :103, NavItem :189, About button :159) become `rounded-[var(--xmd-radius-3)]`; same for `capture.tsx:85` (finding 14).
- Saved toast: scoped asymmetric transition per §2.7 (findings 13, 16).

### 3.2 Hash alias table (CRITICAL — every old deep-link must resolve)

Extend the existing single-alias mechanism (`hash === 'worklist' ? 'clearing' : hash`) into a table:

```ts
const HASH_ALIASES: Record<string, SectionId> = {
  worklist: 'release',   // legacy alias, pre-R4
  clearing: 'release',   // popup deep-link (openClearingSettings) + R4-era links
  general: 'saving',
  downloads: 'saving',
  filters: 'saving',
  cloud: 'sync',
}
const handleHash = () => {
  const hash = location.hash.replace(/^#/, '')
  const target = HASH_ALIASES[hash] ?? hash
  if (isSectionId(target)) setSection(target)
}
```

| Old hash | Resolves to | Origin of the old link |
|---|---|---|
| `#worklist` | `release` | pre-R4 legacy alias (already special-cased today) |
| `#clearing` | `release` | popup `openClearingSettings()` deep-link |
| `#general` | `saving` | default landing / bookmarks |
| `#downloads` | `saving` | bookmarks |
| `#filters` | `saving` | bookmarks |
| `#cloud` | `sync` | capture panel's inline `Cloud ›` anchor (`capture.tsx:67`) |
| `#capture` | `capture` (identity) | popup `openCaptureArchive()` deep-link |
| `#archive` | `archive` (identity) | capture panel `Open archive ›` anchor |
| `#history` / `#about` | identity | bookmarks |

Popup deep-link functions update to the new ids (`openReleaseSettings = openOptionsSection('release')`), but the alias table guarantees any stale `#clearing`/`#worklist` link (bookmarks, older popup builds mid-update) still lands correctly. The capture panel's inline `<a href="#cloud">` is updated to `#sync`; the alias covers stragglers. **Rule: aliases are add-only; never delete an alias once shipped.**

### 3.3 Cluster → content mapping (every existing Field/row accounted for — nothing dropped)

**SAVING** (`panels/saving.tsx`, NEW — absorbs general.tsx + downloads.tsx + filters.tsx; all three source files deleted)
PanelHeader: title `Saving` · description `How media is noticed, fetched, named, filtered, and saved to disk.`

| # | Section title | Rows (settings key → label; copy verbatim from current panels unless noted) |
|---|---|---|
| 1 | `On-page controls` (desc unchanged from general.tsx) | `quickGrabEnabled` → Hover quick grab · `quickGrabModifier` (cond.) → Quick grab modifier + Select (4 options) · `downloadBadgeEnabled` → Show download badge on media · `downloadDockEnabled` → Show download dock · `dockGlassEnabled` (cond.) → Liquid glass dock |
| 2 | `Files & naming` (was Downloads "Save defaults", desc `Naming and sidecars applied to every new download.`) | `filenameTemplate` → Filename template + token mono hint · `sidecarMetadata` → Save metadata sidecar |
| 3 | `Speed` (desc unchanged) | `downloadConcurrency` → Concurrent downloads |
| 4 | `Download mode` (desc unchanged) | ToggleGroup (h-10 items, same `--radius` override as popup §2.8) + active-mode hint · aria2 sub-block (cond.): `aria2Split`, `aria2RpcUrl`, `aria2Secret`, `aria2Dir`, `Grant localhost access` Button, `localhost access granted` line |
| 5 | `Duplicates` (desc unchanged from filters.tsx) | `preventDuplicateDownloads` → Prevent duplicate downloads (keeps `dedupeToggleDelta` coupling) |
| 6 | `Media filters` (desc unchanged) | `skipTypes` ×3 → Skip Photos/Videos/GIFs · `minWidth` · `minHeight` · `maxFileSizeMB` |
| 7 | `Daily budget` (desc unchanged) | `dailyMaxMB` · `dailyMaxCount` · Used-today readout (`local:daily-budget` item moves with it) + `Reset today` Button — **Reset** is correct tier-0 verb, no confirm |
| 8 | `Advanced` (desc unchanged from general.tsx) | `autoRevealSensitiveEnabled` → Auto-reveal sensitive media · `authFallbackEnabled` → Authenticated fallback · `showSavedStatus` → Show "Saved" on downloaded posts |

All action Buttons in options panels (`Reset today`, `Grant localhost access`, Sync's `Test connection`/`Grant access`/`Connect`/`Disconnect`/`Retry failed`/`Back up past downloads`, Archive's `Refresh`/`Show N more`) gain `className` additions merging `min-h-10` (visible 40px height — finding: filters.tsx:203; the buttonVariants-level pseudo-slop alternative is off-limits while the other workflow owns button.tsx, and a full options page has room for honest 40px buttons).

**RELEASE** (`panels/release.tsx`, renamed from worklist.tsx) — row-by-row:

```
PanelHeader
  title: "Release"  (+ Badge variant="destructive" "Account" beside the h1)
  description: "Treat Bookmarks, Likes, and For You as a worklist that empties
  itself as media is saved. Releasing changes your X account and can't be
  undone by this extension — off by default."

Section: "Release after download"
  description: "When on, each post is removed from its list (un-like on Likes,
  un-bookmark on Bookmarks) once its media truly lands. When off, the page
  actions just download."

  Row 1 [Field horizontal]
    Label:  CLEAR_AFTER_DOWNLOAD.label            → "Release after download"
    Desc (off): CLEAR_AFTER_DOWNLOAD.description + " Off by default."
    Desc (on):  "On — every page action also releases."   (11px, muted, inline
                size-1.5 bg-destructive dot — the standing visual state)
    Control: Switch (clearOnSave)
    Toggle-ON gate: ConfirmStrip (250ms preset) rendered inline directly under
    the row; sentence + buttons exactly as §2.3 "Toggle-ON". Toggling OFF: no gate.

  [conditional block when clearOnSave — unchanged border-l pl-4 structure]
  eyebrow: "Release from"
    Row 2: Un-bookmark            (autoUnbookmarkOnSave)  desc "Remove from Bookmarks when complete"          — label deliberately NOT re-verbed; already unambiguous
    Row 3: Un-like                (autoUnlikeOnSave)      desc "Remove from Likes when complete"              — unchanged
    Row 4: Not interested (For You) (autoNotInterestedOnSave) desc unchanged verbatim from worklist.tsx
    Row 5: Release from every list (clearAllListsOnSave)  desc: "Remove a finished post from every list it's
           in, not just the page you're on — un-like a bookmarked post, un-bookmark a liked one. 'Not
           interested' still only fires on For You. Off by default — it's the most aggressive option."
           (no extra badge/color — scope difference, not tier difference)

  Trailing FieldDescription:
    "Run the worklist from the toolbar popup on an X Likes or Bookmarks tab —
    'Download this page' or 'One by one'. This setting only decides whether
    those actions also release."

Section: "Release from the popup"          ← NEW, documentation-only, no controls
  description: "Two rows in the toolbar popup release immediately, without
  downloading anything first. They appear only on X tabs."
  Static prose rows (13px, text-muted-foreground):
    "Release this page… — releases every post currently rendered on the page.
     Asks you to confirm."
    "Release the whole list… — scrolls the entire Likes or Bookmarks list and
     releases everything in it. The single most destructive control in the
     extension; asks you to type RELEASE first."
```

No ConfirmStrip appears on Rows 2–5 — they are scope preferences inside an already-gated feature; only the master toggle-ON is gated.

**CAPTURE** (`panels/capture.tsx`, id/label unchanged) — rows unchanged: `captureEnabled`, `captureAllScrolled`, `captureMirrorEnabled` (with its `Uses your Cloud connection` line now reading `Uses your Sync connection — set that up first (Sync ›)` with `href="#sync"`), Archive link-out section. Fixes: `rounded-[8px]` → `rounded-[var(--xmd-radius-3)]` on the link row.

**SYNC** (`panels/sync.tsx`, renamed from cloud.tsx) — PanelHeader: title `Sync` · description unchanged (`Back up to your own cloud — opt-in, and you hold the keys.`). Sections and every row unchanged: Cloud sync to Convex (`cloudSyncEnabled`, `convexUrl`, `convexSyncSecret`, Test connection, Grant access, status line) · Cloud upload — Drive & Dropbox (`cloudUploadEnabled`, both `CloudProviderRow`s with client-id drafts, Back up past downloads, Retry failed, status lines). Only deltas: `min-h-10` on the six Buttons; component/file rename.

**ARCHIVE** (`panels/archive.tsx`) — structure unchanged (search, list, paging, exports) with these deltas:
- `Clear archive…` → `Erase archive…`, gated by ConfirmStrip (450ms) with sentence `confirmEraseArchiveCopy(n)` and confirm button **`Erase the archive`**; native `confirm()` removed.
- Loading vs empty split (finding 11): while `summary === null` render `FieldDescription` `Loading…`; the teaching empty state (`Nothing captured yet. Turn on Capture tweets and browse X.`) renders only after the fetch resolves with zero conversations.
- Raw text-link buttons (`JSON`, `Markdown`, `Export all · JSONL`, `Erase archive…`) gain `rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50` (no `active:scale` on this surface — finding 10 adjudication).
- Buttons `Refresh` / `Show N more`: `min-h-10`.

**HISTORY** (`panels/history.tsx`) — deltas:
- `Clear history…` → `Erase history…` (red text-link, same focus-ring treatment), gated by ConfirmStrip (450ms — finding 9, P1: this action currently wipes with NO confirmation). Sentence from the new pure helper in `history-section.ts`:
  `confirmEraseHistoryCopy(n)` → `Erase all {n} download records? This cannot be undone. Files on disk are not touched.` Confirm button: **`Erase history`**.
- Empty label (finding 12): `historyEmptyLabel(true, 0)` → `No downloads yet — files you save will appear here.`
- Rows/Badge list otherwise unchanged.

**ABOUT** (`panels/about.tsx`) — additions:
- New Section after Privacy posture: title `Appearance` · description `` (omit) · one prose row: `Follows your system light/dark setting. There is no in-app theme override.` (13px, `text-muted-foreground`). This is the relocated sidebar line — prose, never styled as a control.
- Existing Privacy posture + OAuth redirect URL sections unchanged.

### 3.4 Options-surface conventions (apply to every panel)

- Focus ring pattern on all hand-rolled interactive elements (§2.8 pattern).
- No `transition-all` anywhere (toast fixed per §2.7; panels contain none after the ui-fix workflow lands).
- Dynamic numbers (`Used today`, tweet/conversation counts, `{remaining}`) already `font-mono tabular-nums` — keep; add to any new count.
- `text-balance` on PanelHeader `<h1>` (already), `text-pretty` on descriptions (already via ui.tsx) — new SavingPanel inherits by using the same primitives.

---

## 4. Audit-findings requirement table (all 17 popup/options findings — each a MUST)

Every confirmed finding whose file starts with `src/entrypoints/popup/` or `src/entrypoints/options/`, using the adjudicated `adjustedFix` where one exists. "Where addressed" cites this spec.

| # | Finding (file:line, sev) | Requirement (MUST) | Where addressed |
|---|---|---|---|
| 1 | popup/App.tsx:382 P1 — "One by one"/"Clear page"/"Clear list…" h-8 (32px) trio under the 40px floor, mis-tap-prone 3-col grid | The 3-up grid is dissolved by design: One-by-one becomes an h-10 (40px) Stage secondary; the two release actions become `min-h-10` rows in their own cluster. No popup action control under 40px. | §2.1, §2.2, §2.8 |
| 2 | popup/App.tsx:444 P1 — Mode ToggleGroupItem h-8 | `h-10 flex-1 text-[13px]` on each item. | §2.8 |
| 3 | popup/capture-quick-actions.tsx:72 P2 — five buttons missing `data-slot="button"`, `transition-colors`, `active:scale-[0.97]` | Rebuilt component: every button carries all three (matching App.tsx convention). | §2.8 |
| 4 | popup/capture-quick-actions.tsx:70 P2 — duplicate of #3 (same 5 buttons, press-feedback absence) | Same as #3. | §2.8 |
| 5 | popup/App.tsx:529 P2 — Saved toast `transition-all duration-200`, symmetric enter/exit | `transition-[opacity,transform] ease-[var(--xmd-ease)]` + `duration-200` visible / `duration-150` hidden. | §2.7 |
| 6 | popup/App.tsx:428 P2 — segmented-control radius rules dead in cascade (adjusted: `data-horizontal` never emitted; `--radius` override alone inert) | Preferred fix (data-horizontal on ToggleGroup root) is ALREADY LANDED by the concurrent ui workflow — verify, don't re-apply. This spec adds the now-effective `style={{'--radius':'var(--xmd-radius-3)'}}` on the wrapper and deletes the dead per-item `rounded-[var(--xmd-radius-4)]`. Apply identically to the options Download-mode group in SavingPanel. | §2.8, §3.3 |
| 7 | popup/App.tsx:343 P2 — monitor Clear/Active button ~16px hit box | Renamed **Reset**; `min-h-10 px-2 -my-3` invisible-slop treatment (visual footprint unchanged). | §2.3 Monitor, §2.8 |
| 8 | options/App.tsx:191 P0 — `text-primary` fails AA on light bg/tints (adjusted: needs L≈0.50) | Token fix ALREADY LANDED (`--xmd-accent: oklch(0.50 0.176 250)`, hover `0.44` in app.css) by the concurrent workflow — spec requirement: reference tokens by name only; verification batch re-checks the shipped values render on nav active state, `Edit ›`/`Archive ›` links, toggle-on text. No further code change. | §0 boundary note, §7 batch D |
| 9 | options/panels/history.tsx:21 P1 — history wipe has NO confirmation | `Erase history…` gated by ConfirmStrip with `confirmEraseHistoryCopy(n)` + literal button `Erase history`. (Adjusted fix suggested `confirm()`; superseded by the no-native-confirm contract — the strip is the stronger form of the same requirement, copy helper kept as specified.) | §3.3 History, §2.4 |
| 10 | options/panels/archive.tsx:120 P2 — raw text-link buttons lack focus-visible ring (adjusted: keep raw buttons, add ring + `rounded-sm`, skip `active:scale`, don't swap to `<Button>`) | Exactly the adjusted fix, on archive.tsx JSON/Markdown/Export-all/Erase links and history.tsx Erase link. | §3.3 Archive/History, §3.4 |
| 11 | options/panels/archive.tsx:30 P2 — `summary===null` (loading) renders the "Nothing captured yet" empty state | Branch `summary === null` → `Loading…`; empty teaching copy only after resolved-empty. | §3.3 Archive |
| 12 | popup/history-section.ts:40 P3 — bare `No downloads yet` teaches nothing | `No downloads yet — files you save will appear here.` + test update. | §3.3 History, §6 |
| 13 | options/App.tsx:99 P2 — toast `transition-all`, no `--xmd-ease`, symmetric duration (adjusted: ternary-driven duration + eased base) | Same scoped asymmetric pattern as popup (identical class strings across surfaces). | §2.7 |
| 14 | options/App.tsx:103 P2 — `rounded-[8px]` literals ×3 + capture.tsx:85 duplicate the radius token | All four become `rounded-[var(--xmd-radius-3)]`. | §3.1, §3.3 Capture |
| 15 | popup/App.tsx:364 P2 — no `outline-none focus-visible:ring-3 focus-visible:ring-ring/50` on any hand-rolled popup button (+ capture-quick-actions) | Pattern applied to every interactive element in both surfaces (design contract line; enumerated per zone). | §2.8, §3.4 |
| 16 | popup/App.tsx:530 P3 — popup toast `translate-y-1` vs options `translate-y-2` (adjusted: options is the wrong one; spec says 4px rise) | Both standardize on `translate-y-1`. | §2.7 |
| 17 | options/panels/filters.tsx:203 P2 — no Button size variant reaches 40px; 9+ real actions at 28–32px (adjusted fix preferred a buttonVariants pseudo-slop) | Call-site `min-h-10` on every options action Button (filters Reset today; downloads Grant localhost; sync Test/Grant/Connect/Disconnect/Retry/Backfill; archive Refresh/Show-more). The buttonVariants-level fix is FORBIDDEN here — `button.tsx` is owned by the concurrent workflow; call-site classes are conflict-free and honest on a full page. | §3.3 Saving note, Sync, Archive |

Rejected-by-adjudication items deliberately NOT re-fixed (do not resurrect): native-`confirm()`-as-styling finding (superseded — this spec removes `confirm()` for behavioral reasons, which IS in scope), bare-text-link register on Clear archive/history (the quiet-link register is intentional; we gate them instead), Input h-8 height, Badge `transition-all`, select `duration-100` (select.tsx owned by concurrent workflow anyway).

---

## 5. File-by-file implementation plan

Paths absolute from repo root `/Users/martinfan/devv/xediadownloader/`. "Owned elsewhere" = do not touch.

### 5.1 New files

| File | Becomes |
|---|---|
| `src/components/action-copy.ts` | Pure string module — single source for every verb/confirm string in §2.3/§3.3: `RELEASE_WORD`, `releasePageConfirm`, `releaseListConfirm`, `releasedPageResult(n)`, `releasedListResult(res)`, `turnOnReleaseConfirm`, `confirmEraseHistoryCopy` lives in history-section.ts (history-owned), download-status formatters (`drainResult(n, willClear)`, `sweepResult(res, willClear)`), context-strip labels (`contextLabel(ctx, scope?)`), teaching copy builders (`hoverGrabLine(mod)`, `wholePostLine(mod, mod2)`). Pure functions only — no JSX, no state, no browser API. Imports `plural` from `@/components/capture-copy`. |
| `src/components/confirm-strip-logic.ts` | Pure timing/matching helpers: `typedWordSatisfied(value: string): boolean` (`trim().toLowerCase() === 'release'` — parametrize `word` arg), `guardMs(kind: 'one-shot' \| 'pre-committed')` → 450/250, `isGuardElapsed(armedAt, now, kind)`, `disarmDeadline(armedAt)` → +8000, `underlineStart(armedAt)` → +6000, `outsideClickArmed(armedAt, now)` → now-armedAt > 300. No DOM. |
| `src/components/confirm-strip.tsx` | The ConfirmStrip Preact component per §2.4/§2.5. Props: `{ sentence: string; confirmLabel: string; kind: 'one-shot' \| 'pre-committed'; typedWord?: string; onConfirm: () => void; children: (arm: () => void) => VNode }` — render-prop trigger so the idle control keeps its own styling. Owns: arm state, focus-to-Cancel on arm, Escape/outside-click/8s disarm, guard-window inert confirm, `aria-live` announce, module-level one-armed-strip registry. NO `accesskey` anywhere. Uses the vendored `Input` for the typed-word variant. |
| `src/entrypoints/popup/context.ts` | Pure: `tabContext(url: string): TabContext` (wraps `adapterForUrl` + `pageScope` behind one function; try/catch on `new URL`), `contextLabel(ctx, scopeName?)`, `isXContext(ctx)`. |
| `src/entrypoints/popup/first-run.ts` | `storage.defineItem('local:xmd-popup-intro', { fallback: { opens: 0, done: false } })` + `recordOpen()`, `markDone()`, `shouldShowIntro(state): boolean` (`!done && opens <= 3`). The storage key is deliberately OUTSIDE the Settings schema; popup code is its only writer. |
| `src/entrypoints/options/panels/saving.tsx` | New merged panel per §3.3 table (8 sections; every Field verbatim from general/downloads/filters; hosts `budgetItem` + aria2-grant + dedupe coupling logic moved intact). |
| Test files | `action-copy.test.ts`, `confirm-strip-logic.test.ts`, `context.test.ts`, `first-run.test.ts` (co-located next to sources), `saving.test.ts`, `release.test.ts` — see §6. |

### 5.2 Modified files

| File | Becomes |
|---|---|
| `src/entrypoints/popup/App.tsx` | Rebuilt per §2: zones as local components (ContextStrip/MonitorZone/StageZone/ReleaseCluster/PreferencesZone/Footer) in this one file (they share state; extract later only if it grows). `usePageAction` loses its `confirm` option (ConfirmStrip gates in JSX). Three status slots (`downloadMsg`, `releaseMsg`; capture slot stays in CaptureQuickActions). Local `plural` deleted → import from `@/components/capture-copy` (**closes capture-copy handoff step 5** — see 5.4). Monitor: Reset rename, dead `clearFeedback` state deleted, hit-slop fix. Mode group h-10 + `--radius` override. First-run strip + `first-run.ts` wiring. Toast fix. Focus rings + data-slot on every button. Deep-link fns: `openReleaseSettings` (`#release`), `openCaptureArchive` (`#capture`, unchanged). |
| `src/entrypoints/popup/capture-quick-actions.tsx` | Rebuilt: disclosure `min-h-10`; all buttons get data-slot/transition-colors/active-scale/focus-ring/hit-slop; `Erase archive…` via ConfirmStrip (sentence `confirmEraseArchiveCopy`, button `Erase the archive`); result via `erasedArchiveCopy`; native `confirm()` removed. |
| `src/entrypoints/popup/history-section.ts` | `historyEmptyLabel` reword (§3.3 History); add `confirmEraseHistoryCopy(count)` pure helper (imports `plural` from capture-copy). |
| `src/entrypoints/popup/index.html` | Boot-fallback inline CSS: `min-height: 360px`, drop fixed 600 (§2.9). |
| `src/app.css` | ONLY the frame rules per §2.9 (`html,body,#app` height pins removed; `.xmd-popup` min/max height; `--loading` 360). Token blocks and `[data-slot]` pins untouched (concurrent workflow owns tokens). |
| `src/core/clear/copy.ts` | `CLEAR_AFTER_DOWNLOAD` → `{ label: 'Release after download', description: 'Remove each saved post from its list once its media truly lands.' }`. Const name + module path unchanged (26+ importers, frozen-adjacent; renaming the export is churn without benefit). This file is inside the 100%-coverage gate — string-value changes don't alter coverage. |
| `src/entrypoints/options/App.tsx` | New `SECTIONS` (§3.1), `HASH_ALIASES` (§3.2), sidebar Release badge, delete `Appearance · System` span, radius tokens, toast fix. Imports SavingPanel/ReleasePanel/SyncPanel; drops General/Downloads/Filters/Worklist/Cloud imports. |
| `src/entrypoints/options/panels/capture.tsx` | `#cloud` → `#sync` anchor + label `Sync ›`; radius token on link row; otherwise unchanged. |
| `src/entrypoints/options/panels/archive.tsx` | Erase verb + ConfirmStrip; loading/empty split; focus rings on text-links; `min-h-10` on Refresh/Show-more (§3.3). |
| `src/entrypoints/options/panels/history.tsx` | Erase verb + ConfirmStrip + `confirmEraseHistoryCopy`; focus ring on the link; empty-label passthrough unchanged (helper reworded). |
| `src/entrypoints/options/panels/about.tsx` | Add Appearance prose section (§3.3 About). |
| `src/components/capture-copy.ts` | `confirmClearArchiveCopy` → **rename** `confirmEraseArchiveCopy`, text `Erase all {n} captured tweets? This cannot be undone.`; `clearedArchiveCopy` → **rename** `erasedArchiveCopy`, text `Erased {n} tweets from the archive.` (Two consumers: archive.tsx, capture-quick-actions.tsx — updated in their own rows above. The handoff's "no wording change" rule is explicitly superseded by the locked verb system; document in commit message.) |
| `src/entrypoints/popup/popup-layout.test.ts` | Updated per §6. |
| `src/entrypoints/popup/App.test.ts` | Updated per §6. |
| `src/entrypoints/popup/history-section.test.ts` | Updated per §6. |
| `src/entrypoints/options/App.test.ts` | Updated per §6. |

### 5.3 Renamed / deleted files

| Action | File |
|---|---|
| Rename | `src/entrypoints/options/panels/worklist.tsx` → `release.tsx` (component `ReleasePanel`; contents per §3.3 Release) |
| Rename | `src/entrypoints/options/panels/worklist.test.ts` → `release.test.ts` (rewritten per §6) |
| Rename | `src/entrypoints/options/panels/cloud.tsx` → `sync.tsx` (component `SyncPanel`; content deltas per §3.3 Sync) |
| Delete | `src/entrypoints/options/panels/general.tsx`, `downloads.tsx`, `filters.tsx` (contents fully absorbed by `saving.tsx` — §3.3 table proves nothing is dropped) |

**Never touched:** `src/core/settings/*`, `src/core/schema/*`, all message contracts, `src/components/ui/*` (concurrent workflow), `src/entrypoints/options/ui.tsx` (primitives already fit; zero changes needed), `src/components/capture-export.ts`, `src/entrypoints/overlay.content/*`, `wxt.config.ts`.

### 5.4 Capture-copy handoff fold-in (docs/superpowers/handoffs/2026-07-05-capture-copy-module.md)

Status audit against the live tree: steps 1–4 are ALREADY DONE (`src/components/capture-copy.ts` exists; capture.tsx, archive.tsx, capture-quick-actions.tsx import it). **Outstanding: step 5** — popup `App.tsx` still defines its own byte-identical `plural` (line 32) — and **step 6**, the tree sweep. Both fold into Batch B here: delete the local `plural`, import from `@/components/capture-copy`, then verify `rg -n "n === 1 \? '' : 's'" src -g '!capture-copy.ts'` returns nothing. The handoff's copy-builder exports are carried forward under their new Erase names (5.2); its "no wording change" constraint is superseded by this redesign's locked verb system. After Batch B lands, mark the handoff doc CLOSED (doc edit belongs to the implementing session, not this spec).

---

## 6. Test plan

House idioms: UI panels are pinned by **source-grep tests** (readFileSync + `toContain`/index-ordering, per worklist.test.ts / popup-layout.test.ts); pure helpers get real unit tests. New pure helpers live under `src/entrypoints/` or `src/components/` — **deliberately outside** the 100%-coverage gate (`src/core` + `src/lib` only), so no gate churn. `src/core/clear/copy.ts` stays in-gate but is const-only (coverage unaffected by string edits).

### 6.1 Existing tests — updated vs rewritten

| Test file | Fate | Changes |
|---|---|---|
| `popup/popup-layout.test.ts` | **Rewritten** (most assertions describe the old fixed-600 shell and old verbs) | Height block: `.xmd-popup` contains `min-height: 360px`, `max-height: 600px`, `overflow-y: auto`, and does NOT contain `height: 600px`; `html,\nbody,\n#app` rule has no `height:`/`max-height:` pins; index.html fallback contains `min-height: 360px`. Verb/structure blocks: `Download this page`, `One by one`, `Release this page`, `Release the whole list`, `Reset` present; `'Clear list'`/`'Clear page'`/`'Clear archive'` absent from popup sources. Keep (unchanged intent): settings-moved-out assertions, whole-list message tag (`ClearWholeListRequest` + `onListPage`), scope-summary + `openOptionsSection('release')` deep-link (was `'clearing'`), capture toggle + `fetchCaptureSummary(3)` + RECENT_LIMIT + Export all, monitor-nesting order test. General-panel assertions move to `saving.test.ts` (the file they grep no longer exists). |
| `popup/App.test.ts` | **Updated** | ADR-0019 block survives verbatim (adapter imports, tabAdapter state, `onXTab` derivation). Gate block updates to the new structure: drain/sweep disabled expressions kept; clearVisible/clearWholeList gating now asserted as "release rows render only inside the X-context branch" via ordering greps (e.g. `ReleaseCluster` appears; `ClearWholeListRequest` string only reachable in list context — assert `onListPage` still guards it). Add: source does NOT contain `confirm(` (as a call — regex `/\bconfirm\(/`), does NOT contain `accesskey`. |
| `options/App.test.ts` | **Updated** | Grouping test: settingsIds `['saving','release','capture','sync']`, libraryIds `['archive','history']`, about `utility`. Icon-field guard kept. **New alias block:** grep the `HASH_ALIASES` literal for every §3.2 pair (`worklist: 'release'`, `clearing: 'release'`, `general: 'saving'`, `downloads: 'saving'`, `filters: 'saving'`, `cloud: 'sync'`) + `HASH_ALIASES[hash] ?? hash` mechanism present + old single-ternary alias absent. |
| `options/panels/worklist.test.ts` → `release.test.ts` | **Rewritten** (rename) | Ordering pins on release.tsx: `id="clearOnSave"` before `Release from` eyebrow before `autoUnbookmarkOnSave`; trailing hint after `clearAllListsOnSave`; PanelHeader contains `Release`; `Account` badge present; documentation section contains `Release the whole list` and `RELEASE`; source does not contain `Clearing` or a bare `Clear from`. |
| `popup/history-section.test.ts` | **Updated** | `historyEmptyLabel(true, 0)` → new string; add `confirmEraseHistoryCopy(0/1/2)` cases (`0 download records`, singular `1 download record`? — NO: helper uses `plural(n,'download record')`, so assert `'Erase all 2 download records? This cannot be undone. Files on disk are not touched.'` and the n=1 singular). Existing group/format/fetch tests unchanged. |

### 6.2 New tests

| Test | Pins |
|---|---|
| `src/components/action-copy.test.ts` | Every builder returns the exact §2.3 strings (snapshot-free `toBe` assertions); `RELEASE_WORD === 'RELEASE'`; `drainResult`/`sweepResult` branch coverage (0 / releasing / plain / skipped-clause). |
| `src/components/confirm-strip-logic.test.ts` | `typedWordSatisfied`: `'release'`, `' RELEASE '`, `'Release'` → true; `''`, `'releas'`, `'release the list'` → false. `guardMs('one-shot')===450`, `('pre-committed')===250`. `isGuardElapsed` boundary at exactly guard ms. `disarmDeadline`/`underlineStart` arithmetic. `outsideClickArmed` 300ms grace boundary. |
| `src/components/confirm-strip.test.ts` (source-grep) | Component source contains `focus()` targeting the Cancel ref on arm (grep `cancelRef.current?.focus()`); contains `Escape` handling + trigger-refocus; confirm button renders `aria-disabled` while guarded; typed-word input `onKeyDown` contains `preventDefault` for `Enter` (**"cannot fire on Enter alone"** safety pin); source contains NO `accesskey` (**no-accelerator** pin); `pointer-events-none` present for the guard state. |
| `src/entrypoints/popup/context.test.ts` | URL → TabContext unit cases: x.com/i/bookmarks → `x-list`; x.com/home → `x`; instagram.com/reels → `instagram`; threads.net → `threads`; example.com + garbage URL (`not a url`) → `none`. `contextLabel` strings per §2.3. |
| `src/entrypoints/popup/first-run.test.ts` | `shouldShowIntro({opens:0,done:false})` true; `{opens:4}` false; `{done:true}` false; `markDone`/`recordOpen` write shapes (mock the storage item like history-section.test.ts mocks sendMessage). Storage key is `local:xmd-popup-intro` (grep source — pins "outside Settings schema"). |
| `src/entrypoints/options/panels/saving.test.ts` (source-grep) | Every settings key from the §3.3 Saving table appears exactly once (`quickGrabEnabled`, `quickGrabModifier`, `downloadBadgeEnabled`, `downloadDockEnabled`, `dockGlassEnabled`, `filenameTemplate`, `sidecarMetadata`, `downloadConcurrency`, `downloadStrategy`, `aria2Split`, `aria2RpcUrl`, `aria2Secret`, `aria2Dir`, `preventDuplicateDownloads`, `skipType-`, `minWidth`, `minHeight`, `maxFileSizeMB`, `dailyMaxMB`, `dailyMaxCount`, `local:daily-budget`) — the nothing-dropped guarantee, executable. Section order pins (On-page controls → … → Advanced). Inherits the old popup-layout General-panel badge assertions. |

### 6.3 Safety-property pins (the four the user named, mapped)

1. **Typed-word gate cannot fire on Enter alone** → confirm-strip source-grep (Enter preventDefault in input) + logic test (`typedWordSatisfied` alone never triggers anything — firing requires the button's onClick/onKeyDown path, asserted by grep that `onConfirm` is invoked only from the confirm button handler).
2. **Destructive buttons have no accesskey** → grep `accesskey` returns nothing across `src/entrypoints/popup`, `src/entrypoints/options`, `src/components/confirm-strip.tsx` (assert in confirm-strip.test.ts for the component + in popup-layout.test.ts/App.test.ts for the surfaces).
3. **Confirm strip restates the action** → action-copy.test.ts asserts confirm labels are the literal strings (`Release the list`, `Release this page`, `Erase the archive`, `Erase history`, `Turn it on`) and popup/options source-greps assert the string `>Confirm<` never appears as a button label.
4. **Hash aliases resolve** → options App.test.ts alias block (§6.1).

Full gates after each batch: `bun run check` (oxfmt + oxlint + wxt prepare + tsgo + vitest) and `bun run build`; `bun run test:coverage` only if Batch A's `src/core/clear/copy.ts` edit somehow perturbs the gate (it shouldn't — strings only).

---

## 7. Implementation batches (parallel agents, zero file overlap, dependency-ordered)

Concurrency ground rules: batches B and C both depend on A but are **mutually independent** (disjoint files) — run them in parallel after A lands. No batch touches `src/components/ui/*` or the app.css token blocks (concurrent-workflow ownership, §0). Repo has live concurrent editors: check `git status` / mtimes before each batch, commit per-batch with pathspecs.

**Batch A — Foundations (no dependencies)**
Files: `src/components/action-copy.ts` (+test), `src/components/confirm-strip-logic.ts` (+test), `src/components/confirm-strip.tsx` (+source-grep test), `src/components/capture-copy.ts` (rename two exports + reword — NOTE: this temporarily breaks archive.tsx/capture-quick-actions.tsx imports, so Batch A must ALSO mechanically update those two import sites' names only, nothing else in them… **correction**: to keep batches file-disjoint, `capture-copy.ts` keeps the OLD exports as deprecated aliases (`export const confirmClearArchiveCopy = confirmEraseArchiveCopy`) in Batch A; Batches B/C switch their consumers to the new names; Batch D deletes the aliases), `src/entrypoints/popup/context.ts` (+test), `src/entrypoints/popup/first-run.ts` (+test), `src/core/clear/copy.ts` (verb strings).
Test command: `bun run check`
Exit criteria: all new unit tests green; no consumer compile breaks (aliases in place).

**Batch B — Popup (depends on A)**
Files: `src/entrypoints/popup/App.tsx`, `capture-quick-actions.tsx`, `history-section.ts`, `index.html`, `src/app.css` (frame rules only), `popup-layout.test.ts`, `App.test.ts`, `history-section.test.ts`.
Test command: `bun run check && rg -n "\bconfirm\(|accesskey|transition-all" src/entrypoints/popup src/app.css` (expect zero hits) `&& rg -n "n === 1 \? '' : 's'" src/entrypoints/popup` (zero — handoff step 5/6 close-out for the popup tree).
Exit criteria: §2 fully implemented; all popup tests green.

**Batch C — Options (depends on A; parallel with B)**
Files: `src/entrypoints/options/App.tsx`, `App.test.ts`, `panels/saving.tsx` (+`saving.test.ts`), `panels/release.tsx` (renamed from worklist.tsx, +`release.test.ts`, delete `worklist.test.ts`), `panels/sync.tsx` (renamed from cloud.tsx), `panels/capture.tsx`, `panels/archive.tsx`, `panels/history.tsx`, `panels/about.tsx`, delete `panels/general.tsx`/`downloads.tsx`/`filters.tsx`.
Test command: `bun run check && rg -n "\bconfirm\(|accesskey|transition-all|rounded-\[8px\]" src/entrypoints/options` (zero hits).
Exit criteria: §3 fully implemented; every §3.2 alias resolves; saving.test.ts nothing-dropped sweep green.

**Batch D — Integration verification + alias cleanup (depends on B and C)**
Files: `src/components/capture-copy.ts` (delete the deprecated aliases from A).
Test command: `bun run check && bun run build && rg -n "confirmClearArchiveCopy|clearedArchiveCopy|\bconfirm\(" src` (zero hits outside tests of the new names) `&& rg -n "n === 1 \? '' : 's'" src -g '!capture-copy.ts'` (zero — handoff step 6 full-tree).
Also verify (no code changes): `--xmd-accent` light-mode value is `oklch(0.50 0.176 250)` and toggle-group emits `data-horizontal` (concurrent workflow's fixes this spec depends on — findings 6/8); if either is missing, STOP and coordinate rather than fixing in-batch.
Exit criteria: full gates + build green; extension loads; manual smoke of the five confirm strips + typed-word gate + hash aliases (`options.html#clearing`, `#worklist`, `#general`, `#cloud`).

Batch sizing: A ≈ 7 files, B ≈ 8, C ≈ 13 (mostly moves), D ≈ 1 + verification. Suggested agents: one per batch; B and C in parallel.

---

*End of spec. Authored 2026-07-11 against working-tree state at commit 02fb0b2 + uncommitted concurrent ui/token fixes.*




