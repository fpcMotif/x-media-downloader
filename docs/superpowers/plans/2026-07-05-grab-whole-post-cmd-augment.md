# Grab the whole post: Cmd augment on hover Quick Grab — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On Instagram/Threads, holding **Cmd** in addition to the Quick Grab modifier (default Alt) turns the hover-dwell grab into "download every detected media item of the hovered post."

**Architecture:** Reuse the existing `core/quickgrab.ts` dwell/ring state machine wholesale. Add a handful of pure, unit-tested helpers in `core/quickgrab.ts` and `core/adapters/detection-store.ts`; the only behavioral change is the *payload* the dwell fires (single item → id-de-duped union of the hovered item + `store.valuesForTweet(postId)`) and the *label* the ring shows. The overlay content script wires it: track whether the Cmd augment is held, gate to Instagram/Threads, and branch the payload at fire-time.

**Tech Stack:** TypeScript, Preact (overlay UI), Vitest + happy-dom (tests), WXT (extension build). Package manager: **bun**.

**Design spec:** [`docs/superpowers/specs/2026-07-05-grab-whole-post-cmd-augment-design.md`](../specs/2026-07-05-grab-whole-post-cmd-augment-design.md)

---

## Conventions

- Run one test file: `bunx vitest run <path>`
- Run the full gate (format + lint + typecheck + all tests): `bun run check`
- `check` runs `oxfmt --check` — if it reports formatting diffs, run `bunx oxfmt src` to auto-format in place, then re-run `bun run check`.
- Coverage gate is **100%** over `src/core` + `src/lib` only. Every new function in those trees needs full branch coverage; the overlay entrypoint (`src/entrypoints/**`) is **not** coverage-gated.
- The pure helpers land first (Tasks 1–6), each with its own failing test. The overlay wiring (Task 7) and the options hint (Task 8) come last.

## File Structure

- **Modify** `src/core/quickgrab.ts` — add `allAugmentModifier`, `postGrabActive`, `markAllGrabbed`; extend `quickGrabBadgeLabel`.
- **Modify** `src/core/quickgrab.test.ts` — tests for the above.
- **Modify** `src/core/adapters/detection-store.ts` — add `keysForTweet` (store method) + `postGrabItems` (free function).
- **Modify** `src/core/adapters/detection-store.test.ts` — tests for the above.
- **Modify** `src/entrypoints/overlay.content/index.tsx` — track the augment, gate to IG/Threads, branch payload + label in `fireGrab`/`armHover`.
- **Modify** `src/entrypoints/options/panels/general.tsx` — one discoverability line under the Quick Grab modifier control.

---

## Task 1: `allAugmentModifier` — the collision-free second modifier

**Files:**
- Modify: `src/core/quickgrab.ts`
- Test: `src/core/quickgrab.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/core/quickgrab.test.ts` — first add `allAugmentModifier` to the existing import block from `./quickgrab`, then append this `describe`:

```ts
describe('allAugmentModifier', () => {
  it('is Meta for any non-meta base, and Alt when the base is already Meta', () => {
    expect(allAugmentModifier('alt')).toBe('meta')
    expect(allAugmentModifier('shift')).toBe('meta')
    expect(allAugmentModifier('ctrl')).toBe('meta')
    expect(allAugmentModifier('meta')).toBe('alt')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/core/quickgrab.test.ts`
Expected: FAIL — `allAugmentModifier is not exported` / not defined.

- [ ] **Step 3: Write minimal implementation**

Add to `src/core/quickgrab.ts` (below `allAugmentModifier`'s siblings — e.g. after `isModifierKey`):

```ts
/**
 * The second modifier the user adds on top of the Quick Grab modifier to grab
 * the WHOLE post instead of one item. Meta (Cmd) by default; falls back to Alt
 * when the base modifier is itself Meta, so the two can never be the same key.
 */
export function allAugmentModifier(base: GrabModifier): GrabModifier {
  return base === 'meta' ? 'alt' : 'meta'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/core/quickgrab.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/quickgrab.ts src/core/quickgrab.test.ts
git commit -m "feat(quickgrab): add allAugmentModifier for the grab-all augment key"
```

---

## Task 2: `postGrabActive` — is the whole-post grab active right now

**Files:**
- Modify: `src/core/quickgrab.ts`
- Test: `src/core/quickgrab.test.ts`

- [ ] **Step 1: Write the failing test**

Add `postGrabActive` to the import block, then append:

```ts
describe('postGrabActive', () => {
  const held = flags({ altKey: true, metaKey: true }) // base=alt + augment=meta both held

  it('is true only when base is active, platform is eligible, and the augment is held', () => {
    expect(postGrabActive(true, held, 'alt', true)).toBe(true)
  })
  it('is false when the base modifier is not active', () => {
    expect(postGrabActive(false, held, 'alt', true)).toBe(false)
  })
  it('is false on an ineligible platform (e.g. X)', () => {
    expect(postGrabActive(true, held, 'alt', false)).toBe(false)
  })
  it('is false when the augment modifier is not held', () => {
    expect(postGrabActive(true, flags({ altKey: true }), 'alt', true)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/core/quickgrab.test.ts`
Expected: FAIL — `postGrabActive` not defined.

- [ ] **Step 3: Write minimal implementation**

Add to `src/core/quickgrab.ts` (just below `allAugmentModifier`):

```ts
/**
 * Whether a hover-dwell should grab the WHOLE post rather than one item:
 * the Quick Grab modifier is active, the platform is eligible (Instagram/
 * Threads — never X), and the augment modifier ({@link allAugmentModifier}) is
 * also held. `flags` is any pointer/keyboard event (both carry the modifier flags).
 */
export function postGrabActive(
  baseActive: boolean,
  flags: ModifierFlags,
  base: GrabModifier,
  eligible: boolean,
): boolean {
  return baseActive && eligible && modifierHeld(flags, allAugmentModifier(base))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/core/quickgrab.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/quickgrab.ts src/core/quickgrab.test.ts
git commit -m "feat(quickgrab): add postGrabActive predicate for whole-post grab"
```

---

## Task 3: `markAllGrabbed` — mark many keys grabbed at once

**Files:**
- Modify: `src/core/quickgrab.ts`
- Test: `src/core/quickgrab.test.ts`

- [ ] **Step 1: Write the failing test**

Add `markAllGrabbed` to the import block, then append:

```ts
describe('markAllGrabbed', () => {
  it('marks every key grabbed so none re-fire this press', () => {
    const s = markAllGrabbed(pressModifier(idleQuickGrab), ['A', 'B'])
    expect(canGrab(s, 'A')).toBe(false)
    expect(canGrab(s, 'B')).toBe(false)
    expect(canGrab(s, 'C')).toBe(true)
  })
  it('is a no-op (same reference) when every key is already grabbed', () => {
    const once = markAllGrabbed(pressModifier(idleQuickGrab), ['A', 'B'])
    expect(markAllGrabbed(once, ['A', 'B'])).toBe(once)
  })
  it('is a no-op (same reference) for an empty key list', () => {
    const s = pressModifier(idleQuickGrab)
    expect(markAllGrabbed(s, [])).toBe(s)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/core/quickgrab.test.ts`
Expected: FAIL — `markAllGrabbed` not defined.

- [ ] **Step 3: Write minimal implementation**

Add to `src/core/quickgrab.ts` (just below `markGrabbed`):

```ts
/** Record that every key in `keys` was grabbed this press (idempotent; returns
 *  the same state object when nothing changed). */
export function markAllGrabbed(state: QuickGrabState, keys: Iterable<string>): QuickGrabState {
  let next = state
  for (const key of keys) next = markGrabbed(next, key)
  return next
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/core/quickgrab.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/quickgrab.ts src/core/quickgrab.test.ts
git commit -m "feat(quickgrab): add markAllGrabbed to mark a whole post's keys"
```

---

## Task 4: extend `quickGrabBadgeLabel` for all-mode labels

**Files:**
- Modify: `src/core/quickgrab.ts`
- Test: `src/core/quickgrab.test.ts`

- [ ] **Step 1: Write the failing test**

Append (uses the already-imported `quickGrabBadgeLabel`):

```ts
describe('Quick Grab all-mode badge labels', () => {
  it('shows the whole-post variant with a count for queued/started', () => {
    expect(quickGrabBadgeLabel('charging', { count: 4 })).toBe('Grab all')
    expect(quickGrabBadgeLabel('queued', { count: 4 })).toBe('4 queued')
    expect(quickGrabBadgeLabel('saved', { count: 4 })).toBe('4 started')
    expect(quickGrabBadgeLabel('noted', { count: 4 })).toBe('Already queued')
    expect(quickGrabBadgeLabel('failed', { count: 4 })).toBe('Failed')
  })
  it('keeps the single-item labels when no all-mode descriptor is passed', () => {
    expect(quickGrabBadgeLabel('charging')).toBe('Grabbing')
    expect(quickGrabBadgeLabel('saved')).toBe('Started')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/core/quickgrab.test.ts`
Expected: FAIL — `quickGrabBadgeLabel` ignores the second arg (returns `Grabbing`/`Queued`…).

- [ ] **Step 3: Write minimal implementation**

In `src/core/quickgrab.ts`, add an all-mode label map next to `BADGE_LABEL` and replace the `quickGrabBadgeLabel` body:

```ts
const ALL_BADGE_LABEL: Record<QuickGrabUiPhase, (count: number) => string> = {
  charging: () => 'Grab all',
  queued: (n) => `${n} queued`,
  saved: (n) => `${n} started`,
  noted: () => 'Already queued',
  failed: () => 'Failed',
}

export function quickGrabBadgeLabel(phase: QuickGrabUiPhase, all?: { count: number }): string {
  return all ? ALL_BADGE_LABEL[phase](all.count) : BADGE_LABEL[phase]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/core/quickgrab.test.ts`
Expected: PASS (all quickgrab tests, old and new).

- [ ] **Step 5: Commit**

```bash
git add src/core/quickgrab.ts src/core/quickgrab.test.ts
git commit -m "feat(quickgrab): whole-post badge labels (Grab all / N queued / N started)"
```

---

## Task 5: `keysForTweet` — every by-key entry of one post

**Files:**
- Modify: `src/core/adapters/detection-store.ts` (interface `DetectionStore` + `makeDetectionStore` return object)
- Test: `src/core/adapters/detection-store.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/core/adapters/detection-store.test.ts`, add inside the existing `describe('makeDetectionStore — behavior-preserving (M2 characterization)', ...)` block (the `photo`/`video` helpers at the top of the file are already in scope):

```ts
it('keysForTweet returns every by-key entry of a post, [] for an unknown post', () => {
  const s = makeDetectionStore({ mediaKeyFromUrl })
  s.addDetected([photo('a', 'KA', 't1'), photo('b', 'KB', 't2'), video('v', 'MP4', 'POST', 't1')])
  const t1 = s.keysForTweet('t1')
  expect(t1).toContain('KA') // t1 photo
  expect(t1).toContain('MP4') // t1 video mp4 key
  expect(t1).toContain('POST') // t1 video poster key
  expect(t1).not.toContain('KB') // KB belongs to t2
  expect(s.keysForTweet('t2')).toEqual(['KB'])
  expect(s.keysForTweet('nope')).toEqual([])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/core/adapters/detection-store.test.ts`
Expected: FAIL — `s.keysForTweet is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `src/core/adapters/detection-store.ts`, add to the `DetectionStore` interface (right after the `valuesForTweet` declaration):

```ts
  /** Every media-key the by-key index holds for one post (url, poster, and
   *  `post:…` video keys alike) — the whole-post grab marks all of these. */
  keysForTweet(tweetId: string): string[]
```

And add to the returned object in `makeDetectionStore` (right after the `valuesForTweet` property):

```ts
    keysForTweet: (tweetId) => {
      const out: string[] = []
      for (const [key, item] of byKey) if (item.postId === tweetId) out.push(key)
      return out
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/core/adapters/detection-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/adapters/detection-store.ts src/core/adapters/detection-store.test.ts
git commit -m "feat(detection-store): add keysForTweet to enumerate a post's keys"
```

---

## Task 6: `postGrabItems` — the id-de-duped whole-post payload

**Files:**
- Modify: `src/core/adapters/detection-store.ts`
- Test: `src/core/adapters/detection-store.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/core/adapters/detection-store.test.ts`, add `postGrabItems` to the existing import from `./detection-store`, then add a new top-level `describe` (after the `keysForItem` block):

```ts
describe('postGrabItems', () => {
  it('unions the hovered item with the post items, hovered first, de-duped by id', () => {
    const a = photo('a', 'KA', 't1')
    const b = photo('b', 'KB', 't1')
    const c = video('c', 'MP4', 'POST', 't1')
    expect(postGrabItems(a, [a, b, c]).map((i) => i.id)).toEqual(['a', 'b', 'c'])
    expect(postGrabItems(a, [b, c]).map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })
  it('returns just the hovered item when the post set is empty (tee not seen it yet)', () => {
    const a = photo('a', 'KA', 't1')
    expect(postGrabItems(a, [])).toEqual([a])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/core/adapters/detection-store.test.ts`
Expected: FAIL — `postGrabItems` not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/core/adapters/detection-store.ts`, add a free function near `keysForItem` (top of file, after the `keysForItem` definition):

```ts
/**
 * The whole-post grab payload: the hovered `item` unioned with every already-
 * detected item of its post (`store.valuesForTweet(postId)`), de-duped by id
 * with the hovered item first. Guarantees at least the hovered item, so a post
 * the tee hasn't fully captured yet still grabs what's known.
 */
export function postGrabItems(item: MediaItem, postItems: readonly MediaItem[]): MediaItem[] {
  const byId = new Map<string, MediaItem>()
  byId.set(item.id, item)
  for (const it of postItems) if (!byId.has(it.id)) byId.set(it.id, it)
  return [...byId.values()]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/core/adapters/detection-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify coverage of the new core code**

Run: `bun run test:coverage`
Expected: PASS with 100% coverage (no uncovered lines in `quickgrab.ts` / `detection-store.ts`).

- [ ] **Step 6: Commit**

```bash
git add src/core/adapters/detection-store.ts src/core/adapters/detection-store.test.ts
git commit -m "feat(detection-store): add postGrabItems union helper for whole-post grab"
```

---

## Task 7: wire the augment into the overlay content script

**Files:**
- Modify: `src/entrypoints/overlay.content/index.tsx`

This file is **not** coverage-gated. Verify via `bun run check` (typecheck + lint + format + tests) and manual browser testing.

- [ ] **Step 1: Extend the quickgrab import**

In the `import { … } from '../../core/quickgrab'` block, add `allAugmentModifier`, `postGrabActive`, and `markAllGrabbed` to the named imports.

Add `postGrabItems` to the existing import from `'../../core/adapters/detection-store'`:

```ts
import { makeDetectionStore, postGrabItems } from '../../core/adapters/detection-store'
```

(The current line is `import { makeDetectionStore } from '../../core/adapters/detection-store'`.)

- [ ] **Step 2: Add the boot eligibility flag**

Immediately after `const adapter = adapterForHostname(location.hostname)` and its `if (!adapter) return` guard (near the top of `main`), add:

```ts
    // Whole-post grab (Cmd augment) is Instagram/Threads-only by product decision.
    const postGrabEligible = adapter.platform === 'instagram' || adapter.platform === 'threads'
```

- [ ] **Step 3: Add the augment-held tracking scalar**

Next to `let grab: QuickGrabState = idleQuickGrab` (in the Quick Grab state block), add:

```ts
    // Whether the Cmd augment is held right now (all-mode). Tracked as a scalar
    // because the dwell fires on a timer with no event in hand.
    let postGrabArmed = false
```

- [ ] **Step 4: Widen the `grabUi` type with the all-mode fields**

Change the `grabUi` declaration from:

```ts
    let grabUi: {
      key: string
      rect: Rect
      phase: QuickGrabUiPhase
    } | null = null
```

to:

```ts
    let grabUi: {
      key: string
      rect: Rect
      phase: QuickGrabUiPhase
      all?: boolean
      allCount?: number
    } | null = null
```

- [ ] **Step 5: Reset the augment on release**

In `releaseAll`, add `postGrabArmed = false` alongside the other resets:

```ts
    const releaseAll = (): void => {
      if (!grab.active && grabUi === null) return
      grab = releaseModifier()
      clearDwell()
      setCursorActive(false)
      postGrabArmed = false
      grabUi = null
      rerender()
    }
```

- [ ] **Step 6: Add a helper that refreshes all-mode + a charging ring's label**

Add near `releaseAll` (after it is fine):

```ts
    // Update all-mode and, if a ring is already up (charging/noted), re-label it
    // live so pressing/releasing Cmd without moving the cursor is reflected.
    const refreshPostGrabArmed = (next: boolean): void => {
      if (next === postGrabArmed) return
      postGrabArmed = next
      if (grabUi && (grabUi.phase === 'charging' || grabUi.phase === 'noted')) {
        grabUi = { ...grabUi, all: next }
        rerender()
      }
    }
```

- [ ] **Step 7: Branch the payload and label in `fireGrab`**

Replace the body of `fireGrab` (from `grab = markGrabbed(grab, key)` onward) so it expands the payload in all-mode:

```ts
      grab = markGrabbed(grab, key)
      const all = postGrabArmed
      const items = all ? postGrabItems(item, store.valuesForTweet(item.postId)) : [item]
      // Marking every key of the post keeps a cursor sweep across sibling slides
      // from re-charging the ring (downstream the admission gate dedups anyway).
      if (all) grab = markAllGrabbed(grab, store.keysForTweet(item.postId))
      // After the dwell completes, move out of the charge state immediately.
      // The background reply then confirms whether the browser/aria2 handoff started.
      grabUi = all
        ? { key, rect: rectOf(media), phase: 'queued', all: true, allCount: items.length }
        : { key, rect: rectOf(media), phase: 'queued' }
      rerender()
      runHandoff({
        items,
        trace: { fn: traceQuickGrab, item, armedAt: hoverArmedAt },
        isStale: () => grabUi === null || grabUi.key !== key,
        resolve: (ok) => {
          if (grabUi) grabUi = { ...grabUi, phase: ok ? 'saved' : 'failed' }
        },
      })
```

(Leave the early-return guards above `grab = markGrabbed(...)` — the `liveGrabTarget`/`resolveHoverItem` null checks — exactly as they are.)

- [ ] **Step 8: Carry the all-mode flag onto the charging/noted ring in `armHover`**

Replace `armHover` so the ring reflects all-mode from the moment it arms:

```ts
    const armHover = (media: HoverMediaElement, key: string): void => {
      if (canGrab(grab, key)) {
        grabUi = { key, rect: rectOf(media), phase: 'charging', all: postGrabArmed }
        rerender()
        hoverArmedAt = Date.now()
        traceQuickGrab('armed', { key })
        dwell = setTimeout(() => fireGrab(media, key), quickGrabDwellMs)
      } else {
        grabUi = { key, rect: rectOf(media), phase: 'noted', all: postGrabArmed }
        rerender()
      }
    }
```

- [ ] **Step 9: Track the augment on `mousemove`**

In the `mousemove` listener, right after `const grabbing = qgEnabled && syncGrabFromPointer(e)`, add:

```ts
      refreshPostGrabArmed(postGrabActive(grab.active, e, qgModifier, postGrabEligible))
```

- [ ] **Step 10: Capture the augment when the base modifier is pressed**

In the existing base-modifier `keydown` listener, right after `grab = pressModifier(grab)`, add:

```ts
      postGrabArmed = postGrabActive(grab.active, e, qgModifier, postGrabEligible)
```

(This catches "Cmd already held when Alt is pressed" so the first ring arms in all-mode.)

- [ ] **Step 11: Add dedicated augment keydown/keyup listeners**

After the existing base `keyup` / `blur` listeners, add:

```ts
    // The Cmd augment (grab whole post): update all-mode even without a mousemove
    // and re-label a live ring. `allAugmentModifier(qgModifier)` is read fresh each
    // event because the base modifier can change via settings at runtime.
    ctx.addEventListener(window, 'keydown', (event) => {
      const e = event as KeyboardEvent
      if (!qgEnabled || !postGrabEligible) return
      if (!isModifierKey(e.key, allAugmentModifier(qgModifier))) return
      refreshPostGrabArmed(postGrabActive(grab.active, e, qgModifier, postGrabEligible))
    })
    ctx.addEventListener(window, 'keyup', (event) => {
      const e = event as KeyboardEvent
      if (!postGrabEligible) return
      if (!isModifierKey(e.key, allAugmentModifier(qgModifier))) return
      refreshPostGrabArmed(false)
    })
```

- [ ] **Step 12: Use the all-mode label in the `Overlay` render**

In the `Overlay` component, change the grab badge span from:

```tsx
              <span class="xmd-grab__badge">{quickGrabBadgeLabel(grabUi.phase)}</span>
```

to:

```tsx
              <span class="xmd-grab__badge">
                {quickGrabBadgeLabel(
                  grabUi.phase,
                  grabUi.all ? { count: grabUi.allCount ?? 0 } : undefined,
                )}
              </span>
```

- [ ] **Step 13: Typecheck, lint, and test**

Run: `bun run check`
Expected: PASS (format clean, no lint errors, typecheck clean, all tests green).

- [ ] **Step 14: Commit**

```bash
git add src/entrypoints/overlay.content/index.tsx
git commit -m "feat(overlay): Cmd+Alt hover grabs the whole post on Instagram/Threads"
```

---

## Task 8: options discoverability hint

**Files:**
- Modify: `src/entrypoints/options/panels/general.tsx`

- [ ] **Step 1: Add the helper line under the modifier control**

Replace the Quick Grab modifier `Field` (the block gated by `{settings.quickGrabEnabled && ( … )}` that contains `<FieldLabel htmlFor="quickGrabModifier">`) so its label sits in a `FieldContent` with a description:

```tsx
        {settings.quickGrabEnabled && (
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="quickGrabModifier">Quick grab modifier</FieldLabel>
              <FieldDescription>
                Hold {settings.quickGrabModifier === 'meta' ? 'Alt' : 'Cmd'} as well to grab the
                whole post (Instagram &amp; Threads)
              </FieldDescription>
            </FieldContent>
            <Select
              value={settings.quickGrabModifier}
              onValueChange={(value: string) =>
                void update({ quickGrabModifier: value as Settings['quickGrabModifier'] })
              }
            >
              <SelectTrigger
                id="quickGrabModifier"
                aria-label="Quick grab modifier"
                className="w-44"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                <SelectGroup>
                  <SelectItem value="alt">Alt / Option</SelectItem>
                  <SelectItem value="shift">Shift</SelectItem>
                  <SelectItem value="ctrl">Control</SelectItem>
                  <SelectItem value="meta">Cmd / Win</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        )}
```

(`FieldContent`, `FieldLabel`, and `FieldDescription` are already imported in this file — confirm the import line; add any that is missing.)

- [ ] **Step 2: Typecheck, lint, and test (and fix any options test that asserts on this Field's copy)**

Run: `bun run check`
Expected: PASS. If `src/entrypoints/options/App.test.ts` asserts exact copy/structure around the modifier Field, update that assertion to match; the added description is the intended change.

- [ ] **Step 3: Commit**

```bash
git add src/entrypoints/options/panels/general.tsx
git commit -m "docs(options): hint that Cmd grabs the whole post (IG/Threads)"
```

---

## Final verification

- [ ] **Full gate green**

Run: `bun run check && bun run test:coverage`
Expected: PASS, 100% coverage over `src/core` + `src/lib`.

- [ ] **Build succeeds**

Run: `bun run build`
Expected: PASS.

- [ ] **Manual browser verification** (not automatable here — note results)

1. Load the built extension; open a logged-in **Instagram** feed with a carousel post (video + photos).
2. Enable Quick Grab (default Alt) in options; confirm the new hint line reads "Hold Cmd as well…".
3. Hold **Alt** only, hover one photo → ring says `Grabbing` → after ~0.5s that **one** item downloads.
4. Hold **Cmd+Alt**, hover the same post → ring says `Grab all` → after the dwell the **whole post** (all photos + video) downloads; ring shows `N queued` → `N started`.
5. Still holding Cmd+Alt, sweep across sibling slides of the same post → the ring does **not** re-charge/re-fire it.
6. Release **Cmd** (keep Alt) while hovering → ring reverts to `Grabbing` (single-item mode).
7. Repeat 3–6 on **Threads**.
8. On **X**, confirm Cmd+Alt does **not** trigger whole-post grab — Alt-hover single grab is unchanged.
```
