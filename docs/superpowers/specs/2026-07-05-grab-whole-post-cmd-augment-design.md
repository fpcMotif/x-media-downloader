# Grab the whole post: a Cmd augment on hover Quick Grab (Instagram/Threads) — design

**Date:** 2026-07-05
**Status:** Approved for planning

## Goal

Today on Instagram and Threads, holding the Quick Grab modifier (default **Alt/Option**) and hovering one media item downloads **that one item** after a short dwell (`core/quickgrab.ts` + the overlay's dwell/ring machinery in `src/entrypoints/overlay.content/index.tsx`). There is a page-wide "Download all detected media" launcher pill, but no gesture to grab **just the post under the cursor** — a carousel of video + photos — in one action.

This spec adds that gesture: while the Quick Grab modifier is held, **also holding Cmd (Meta)** turns the same hover-dwell into "grab every detected media item of the hovered post." It reuses the existing dwell + ring state machine wholesale; the only behavioral change is the _payload_ the dwell fires and the _label_ the ring shows.

Scoped to **Instagram and Threads only** (per the product decision). X is deliberately excluded — its per-item grab and page-wide launcher stay exactly as they are.

## Decisions (locked)

1. **Gesture:** Cmd+Alt **hover-dwell** (not a literal click) — consistent with today's Alt-hover single grab, and reuses the ring/dwell/state machine rather than adding a parallel click path.
2. **Scope of "all":** grab **what is detected right now** — the union of the hovered item and `store.valuesForTweet(postId)`, de-duped by id. No waiting for the network capture to complete; degrades gracefully to just the hovered item when the tee hasn't seen the rest of the post yet.
3. **Platforms:** Instagram + Threads only. Disabled on X.

## Background: why `valuesForTweet(postId)` is the right source

- Every `MediaItem` carries a `postId`. `DetectionStore.valuesForTweet(postId)` already returns every detected item of one post (X uses it today to gate the For-You "Not interested" clear — see `overlay.content/index.tsx`'s `forYouClearExpect`).
- On Instagram/Threads the full post (whole carousel, video + photos) is populated by the GraphQL **tee** (`detectFromResponse` → `meta-shared/detect.detectMediaItems`), which assigns one shared `postId` and a per-slide `index` across the post. So once the tee has seen a post, `valuesForTweet(postId)` is the whole carousel.
- A hovered **photo the tee already knows** resolves (via `adapter.resolveHoverItem` → `detected.get(key)`) to that tee item, whose `postId` groups the carousel. A hovered **video** likewise resolves to its tee item (real `postId`).
- A hovered **photo the tee has NOT seen yet** resolves to the DOM fallback `resolveMetaImageElement`, whose `postId` is set to the media key itself and which is **not** in the store. `valuesForTweet(thatKey)` is therefore `[]`. The union-with-the-hovered-item rule (Decision 2) is exactly what makes this case still grab the one known photo instead of nothing.

## Design

### 1. Trigger & the augment modifier

While Quick Grab is enabled and its base modifier is held, the overlay is already in grab mode (`grab.active`). The new behavior activates when, on an **Instagram or Threads** tab, the **augment modifier** is _also_ held.

- **Augment modifier** = `meta` (Cmd/⊞), unless the user has reconfigured the base modifier to `meta`, in which case it is `alt`. This guarantees base ≠ augment. A pure helper computes it: `allAugmentModifier(base: GrabModifier): GrabModifier`.
- **Augment-held tracking** mirrors how the base modifier is already tracked (for the default base `alt` the augment is `meta`, so this is "is Cmd held"):
  - `mousemove` reads the live augment flag via `modifierHeld(e, allAugmentModifier(qgModifier))` (ground truth, self-heals a swallowed keyup) — this is the primary path since the user moves the cursor while hovering.
  - `keydown`/`keyup` of the augment key update it for the "already parked on media, then press Cmd" case, and re-label the ring live.
  - `blur`, modifier release, and `wxt:locationchange` reset it (same lifecycle points that call `releaseAll()`).
- **Eligibility** is resolved once at content-script boot: `postGrabEligible = adapter.platform === 'instagram' || adapter.platform === 'threads'`.
- **All-mode active** ⇔ `grab.active && augmentHeld && postGrabEligible`. A pure predicate expresses it: `postGrabActive(baseActive, flags, base, eligible)` using the existing `modifierHeld`.

The augment does **not** change _arming_ — the dwell still arms on the hovered media key exactly as today. It only changes what fires and how the ring is labeled. All-mode is read at fire-time from the live tracked flag.

### 2. Payload at fire-time

In `fireGrab`, after the existing resolve of the single hovered `item`:

- **Single mode (unchanged):** send `[item]`.
- **All mode:** send `postGrabItems(item, store.valuesForTweet(item.postId))` — a pure helper returning the id-de-duped union `[item, ...postItems]` (the hovered item first, guaranteeing ≥1). On X this branch is unreachable (`postGrabEligible` is false).

The send path is the existing `runHandoff(...)` / `sendTracked(items, ...)`, which already accepts an item array (the launcher pill sends `store.values()` through it). `forYouClearExpect` returns `undefined` off-X, so no clear-gate coupling.

### 3. Fire-once-per-post

Today the dwell marks the single hovered **key** grabbed so a cursor sweep fires each item once per press. In all-mode, after firing, mark **every key of the post** grabbed so sweeping across sibling slides of the same post doesn't re-charge/re-fire the whole-post grab:

- New store read `keysForTweet(postId): string[]` — every key in the by-key index whose item's `postId` matches (mirrors `valuesForTweet`). This naturally covers url keys, preview (poster) keys, and the `post:…` DOM video keys, since all live in the by-key index.
- New pure `markAllGrabbed(state, keys): QuickGrabState` folds many keys into the grabbed set (idempotent, dedup).

This is a UX nicety, not a correctness requirement — the download admission gate already de-dups duplicate items downstream (`duplicate → "already saved"`). It just keeps the ring quiet.

### 4. Ring feedback

Same grab ring anchored to the hovered media, with a distinct label set when `grabUi.all` is set:

| phase    | single label (today) | all-mode label   |
| -------- | -------------------- | ---------------- |
| charging | `Grabbing`           | `Grab all`       |
| queued   | `Queued`             | `N queued`       |
| saved    | `Started`            | `N started`      |
| noted    | `Already queued`     | `Already queued` |
| failed   | `Failed`             | `Failed`         |

`N` is the count of items sent (known at fire-time; the `charging` phase precedes the fire, so it shows the mode word rather than a count). `grabUi` gains two optional fields: `all: boolean` and `allCount?: number`. `quickGrabBadgeLabel(phase, all?)` is extended to take the optional all-mode descriptor. When the augment is pressed/released while a `charging` ring is up, the ring's `all` flag and label refresh live.

**Deferred (not in this spec):** drawing the ring around the whole _post container_ instead of the hovered media. It would need a per-adapter "post container rect" and is a pure polish; keeping the ring on the hovered media keeps this change focused.

### 5. Discoverability

In the options General panel (`src/entrypoints/options/panels/general.tsx`), under the Quick Grab modifier control, add one line of helper text:

> _Hold Cmd as well to grab the whole post (Instagram & Threads)._

No new setting/toggle — the augment rides on `quickGrabEnabled` being on (YAGNI; a dedicated toggle can come later if accidental triggers prove a problem).

## Module changes

### `src/core/quickgrab.ts` (pure — 100% coverage-gated)

- `allAugmentModifier(base: GrabModifier): GrabModifier` — `base === 'meta' ? 'alt' : 'meta'`.
- `postGrabActive(baseActive: boolean, flags: ModifierFlags, base: GrabModifier, eligible: boolean): boolean` — `baseActive && eligible && modifierHeld(flags, allAugmentModifier(base))`.
- `markAllGrabbed(state: QuickGrabState, keys: Iterable<string>): QuickGrabState` — fold `markGrabbed` over `keys`, returning the same state object when nothing changed (idempotent).
- `quickGrabBadgeLabel(phase, all?: { count: number })` — extended; all-mode variant per the table above.

### `src/core/adapters/detection-store.ts` (pure — 100% coverage-gated)

- `keysForTweet(postId: string): string[]` added to `DetectionStore` — every by-key entry whose item's `postId === postId`.
- `postGrabItems(item: MediaItem, postItems: readonly MediaItem[]): MediaItem[]` — id-de-duped `[item, ...postItems]`, hovered item first. (Free function exported from `detection-store.ts` alongside `keysForItem`; kept pure and unit-tested.)

### `src/entrypoints/overlay.content/index.tsx` (wiring — not coverage-gated)

- `postGrabEligible` boot flag; `augmentHeld` tracked scalar; helpers to read all-mode via `postGrabActive`.
- `mousemove` sets `augmentHeld = modifierHeld(e, allAugmentModifier(qgModifier))`; augment `keydown`/`keyup` set it and refresh the ring label; reset on `blur`/`releaseAll`/`locationchange`.
- `fireGrab`: choose payload (single vs `postGrabItems`), set `grabUi.all`/`allCount`, and `markAllGrabbed(store.keysForTweet(postId))` in all-mode.
- `armHover`/`grabUi` plumb the `all` flag for the charging label.

### `src/entrypoints/options/panels/general.tsx`

- One `FieldDescription`/helper line under the Quick Grab modifier select.

## Testing

- **`src/core/quickgrab.test.ts`:** `allAugmentModifier` (each base incl. `meta`); `postGrabActive` truth table (base inactive / ineligible platform / augment not held / all held); `markAllGrabbed` (adds many, idempotent no-op returns same ref, empty iterable); extended `quickGrabBadgeLabel` (single + all-mode per phase).
- **`src/core/adapters/detection-store.test.ts`:** `keysForTweet` returns every key (url + preview + `post:…`) of a post's items and `[]` for an unknown post; `postGrabItems` unions + de-dups by id, hovered item first, and returns `[item]` when `postItems` is empty.
- **Overlay wiring:** kept thin; browser-verified manually on live Instagram and Threads (Cmd+Alt hover a carousel → whole post downloads; sweeping sibling slides doesn't re-fire; releasing Cmd reverts the label to single-grab).

## Non-goals / known limitations

- **X is out of scope** by decision — the gesture is disabled there.
- **Partial capture:** if the tee hasn't captured a post's full carousel yet, all-mode grabs only what's detected (possibly just the hovered item). This is the accepted "grab what's detected now" behavior, consistent with the codebase's honest-gaps posture (see `meta-shared/post-anchor.ts`).
- **Whole-post ring outline** is deferred (§4).
- **No new setting** — the augment is always available whenever Quick Grab is on (§5).
