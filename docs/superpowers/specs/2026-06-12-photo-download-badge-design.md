# Photo Download Badge — Design Spec

- **Date:** 2026-06-12
- **Status:** Approved (design reviewed in session; spec awaiting user sign-off)
- **Surfaces:** timeline hover + X lightbox
- **Visual reference:** Figma — https://www.figma.com/design/h1EIKvAveBTW45TXaqog3D

## 1. Overview

A per-media download affordance borrowed from X's own corner-badge pattern: a
small circular badge that **bounces** into the bottom-right corner of a media
preview when the user hovers it (timeline) or opens the photo viewer
(lightbox). One click downloads that Media Item at Original quality. The
bounce attracts; the azure glyph identifies the extension; the badge otherwise
stays quiet.

This is the third fast path alongside Quick Grab (modifier + dwell) and the
global launcher (bulk). It targets the user who *sees* a photo and wants it,
without knowing or holding a modifier.

### Goals

- A visible, charming, instantly understood per-photo download affordance.
- Lively motion ("a little bounce, jumping lively and lovely") that still fits
  the brand: fast, restrained, trustworthy. Attention is earned at entrance,
  not nagged for perpetually.
- Zero new permissions, zero new network behavior — clicks ride the existing
  passive pipeline.

### Non-goals

- No per-photo flyout menus (whole-tweet/thread actions stay on the launcher).
- No badge on unresolvable media — the badge must never promise a download it
  cannot deliver.
- No perpetual attractor animation.

## 2. Interaction Model

- **Timeline:** pointer enters a resolvable media preview → badge enters with
  the bounce (34 px circle, 10 px inset, bottom-right of the media rect).
  Pointer leaves → quiet exit (150 ms fade + 4 px sink; exits are softer than
  enters).
- **Lightbox:** when the hovered/clicked photo is inside X's viewer
  (`[aria-modal="true"]` / `[role="dialog"]` ancestor), the badge renders at
  40 px with a 12 px inset on the image rect, same states.
- **Idle nudge:** if the badge is shown and unclicked for 2.2 s, it plays one
  two-hop nudge (720 ms), then never nudges again for that entrance.
- **Click:** instant download of that Media Item at Original quality. Badge
  morphs: arrow → spinner (queued) → green check (saved) or danger "!"
  (failed). Clicking a failed badge retries. Press feedback: scale 0.96.
- **Resolvability gate:** the badge appears only when the hovered element maps
  to a detected `MediaItem` — photos may use the DOM-only resolver fallback;
  videos/GIFs require the GraphQL tee to have mapped their poster.
- **Quick Grab interplay:** while the Quick Grab modifier is held, the badge
  hides. One affordance at a time.
- **Hit target:** visible 34/40 px; effective hit area extended to ≥ 44 px via
  a pseudo-element. Badge and Quick Grab ring never own the same moment, so
  hit areas cannot overlap.

## 3. Visual & Motion Spec

Variant "Accent spark", as prototyped and tuned ("livelier") in session.

- **Surface:** dark glass scrim `oklch(0.18 0.012 255 / 0.88)`,
  `backdrop-filter: blur(8px)`, inset 1 px ring `oklch(0.62 0.18 245 / 0.5)`,
  half-strength glow `0 0 6px oklch(0.62 0.18 245 / 0.18)`, drop shadow
  `0 2px 8px oklch(0 0 0 / 0.35)`.
- **Glyph:** the launcher's arrow-into-tray path, stroke
  `oklch(0.72 0.16 245)`, 18 px (timeline) / 21 px (lightbox).
- **Saving:** thin spinner arc, 800 ms linear rotation.
- **Saved:** green glass `oklch(0.32 0.06 160 / 0.92)`, ring
  `oklch(0.7 0.16 160 / 0.7)`, check `oklch(0.84 0.14 160)`.
- **Failed:** `--xmd-danger` family, exclamation glyph.
- **Entrance** (480 ms, `cubic-bezier(0.23, 1, 0.32, 1)`, never from scale 0):
  `0%` opacity 0, translateY(14px) scale(0.5) → `48%` translateY(-8px)
  scale(1.18) → `70%` translateY(2px) scale(0.95) → `86%` translateY(-2px)
  scale(1.04) → `100%` rest.
- **Nudge** (720 ms, ease): two diminishing hops — translateY(-7px)
  scale(1.06), settle, translateY(-4px) scale(1.03), settle.
- **Icon swaps:** cross-fade both icons in the DOM — opacity 0→1,
  scale 0.25→1, blur 4px→0, 220 ms `cubic-bezier(0.2, 0, 0, 1)`.
- **Reduced motion:** 150 ms opacity fade only; no jump, no nudge.
- **Tokens:** reuse the `--xmd-*` family in
  `src/entrypoints/overlay.content/style.css`; new badge-specific properties
  join that block.

## 4. Architecture

- **`src/core/badge.ts`** — pure state machine modeled on `core/quickgrab.ts`.
  Phases: `idle → shown → nudged → queued → saved | failed`. Pure predicates
  for visibility (item resolvable ∧ setting enabled ∧ modifier not held) and
  data constants for timing (nudge delay, revert delays). No DOM access.
- **`src/entrypoints/overlay.content/index.tsx`** — renders the badge inside
  the existing shadow-root Preact app, reusing wholesale: the
  `mousemove`/`scroll` hover tracking, `mediaAtPoint` hit-testing,
  `previewKeyFromMedia` + `byKey`/`byId` lookup, `rectOf` fixed positioning
  with scroll rect refresh, and `sendTracked` → background download pipeline.
- **Trace events:** `DownloadTraceEvent` with `source: 'badge'`, stages
  `shown`, `nudged`, `queued`, `start-ack`, `start-failed`.
- **Lightbox sizing** is a presentation decision made at render time from the
  modal-ancestor check; the state machine is surface-agnostic.

## 5. Settings

- New `downloadBadgeEnabled: boolean`, **default `true`**, in the
  `core/settings` schema with a corrupt-recovery default.
- Popup toggle "Show download badge on media" beside the Quick Grab controls;
  live-updates open tabs via the existing `watchSettings` path.
- The badge renders only after stored settings resolve — a user who disabled
  it never sees a flash (mirrors Quick Grab's fail-closed posture).

## 6. Edge Cases

- **Virtualized timeline:** before a click resolves, re-verify
  `media.isConnected`, the media key still matches, and the element is still
  under the badge's rect — the same guards `fireGrab` uses.
- **Corner collisions:** X's ALT badge sits bottom-left in the timeline and
  the lightbox action bar sits below the image, so bottom-right of the image
  rect is safe on both surfaces. If X chrome ever occupies it, the badge
  insets upward 44 px rather than overlapping.
- **Nudge frequency:** at most once per entrance; re-hovering replays the
  entrance (inherent to hover UI) but the nudge stays a single, rare gesture.
- **SPA navigation:** `wxt:locationchange` clears badge state alongside the
  existing overlay resets.

## 7. Testing

- **Vitest:** `core/badge.ts` transitions (entrance, nudge scheduling, queued,
  saved, failed, retry), visibility predicates (setting off, modifier held,
  unresolvable item), and the settings schema addition including
  corrupt-recovery defaults.
- **Manual motion QA:** DevTools slow-mo on both surfaces, reduced-motion mode,
  and X dark/dim/light themes.
- **No new permissions; no new network behavior.**

## 8. References

- Interactive motion prototypes: in-session widgets
  (`photo_download_badge_motion_prototype`, `badge_b_livelier_bounce_final`).
- Static state sheet: Figma file above.
- Pattern reference: X's native photo corner badge (user screenshot, 2026-06-12).
