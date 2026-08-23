# Why the tests missed the cloaked-image regression — and what now guards it

Issue: x-media-downloader #92 (Threads Quick Grab dwell died as `grab-target-stale` on every
`pointer-events:none` image). 2267 unit tests were green the whole time.

## Why nothing went red

1. **One invariant, tested as two halves.** ARM (`nonInteractiveMediaAt` → `mediaAtPoint` →
   `resolveHoverMedia`) had a `pointer-events:none` case since 2026-07-05. FIRE (`mediaStillUnderPointer`)
   only had "media in stack" and "X hidden video via player container". Nothing stated *arm ⇒ hold* —
   that whatever ARM resolves under an unchanged DOM and cursor must still be accepted at fire time.
2. **Example tests enumerate the author's model.** The author knew cloaked images existed (the
   LIVE-VERIFIED note on `nonInteractiveMediaAt` says so) but never revisited the fire-time function,
   and an example suite cannot flag "a case the sibling function handles that this one doesn't".
3. **The composition point was untestable.** `holdsKey` / `liveGrabTarget` lived as closures in
   `overlay.content/index.tsx`, which is outside the coverage gate by design. No test ever ran
   `resolveHoverMedia` and then `mediaStillUnderPointer` on the same stack.
4. **The 2026-06 test plan encoded the wrong assumption.** OV-N6 in `2026-06-12-unit-test-design.md`
   reads "`elementsFromPoint` no longer contains media → cleared". Implemented faithfully, that row
   would have *enshrined* the bug: a cloaked image is never in `elementsFromPoint`, so "not in the
   stack" is not "moved away".
5. **Live verification stopped at the first visible signal.** The 2026-07-05 live check confirmed the
   ring *appears* on Threads. The download — the thing the ring promises — was never confirmed.

## What guards it now

| layer | file | what it pins |
|---|---|---|
| Property (fast-check, 300 runs each) | `src/core/adapters/hover-resolve.property.test.ts` | P1 *arm ⇒ hold* over generated DOM scenes (wrapper depth, cloaked/interactive, occluders, cursor in/out); P2 *hold ⇒ geometry* (the fix is not over-permissive); P3 movement falsifies hold; P4 occlusion symmetry; P5 key stability under node re-creation. The `elementsFromPoint` stack is synthesized from the **documented hit-test spec** (top-most first; `pointer-events:none` excluded) — the assumption that was wrong is now the explicit model, and the live CDP loop is the check on the model. |
| Shape catalogue | `src/core/adapters/hover-shapes.test.ts` | One row per DOM shape observed live (Threads carousel slide, Threads `<picture>` photo, Threads video card, Instagram feed photo, X photo under a hit-target div, X hidden video, Instagram reel under a 0.5 scrim, lightbox in/outside a modal), each asserting ARM and FIRE agree. Add a row whenever a live session shows a new shape. |
| Fire-time guard matrix (OV-N6, corrected) | `src/entrypoints/overlay.content/hover.test.ts` | `holdsKey` / `liveGrabTarget` extracted behind `HoverProbe`: holds interactive and cloaked media; refuses detached / key-swapped / pointer-left / scrolled-away; re-resolves a recycled node with the same key, drops a different key. Plus `focusTransition` / `focusAfterActivation`: a grab released mid-dwell re-arms the same media on the next activation. |
| State machine | `src/packages/overlay/tests/quickgrab.property.test.ts` | `markGrabbed` idempotence/order-independence, `canGrab` vs the grabbed set, release forgets, `syncModifierFromFlags` purity, `allAugmentModifier(base) !== base`. |
| Live (not CI) | `~/.claude/skills/annotated-screenshot/examples/threads-cloaked-img.json`, `scripts/cdp-xmd-console.mjs` | Trusted Alt+Meta hover via CDP on the debug Chrome; the SW trace must reach `quickgrab queued`. |

Red-capability: with `mediaStillUnderPointer` reverted to its pre-fix body, P1 fails in 2 shrunk
tries with the minimal counterexample — a 4×4 `pointer-events:none` `<img>` inside one wrapper div,
cursor inside — which is the Threads shape. P2–P5 stay green under both bodies by design (they guard
the fix against over-reach and the surrounding contracts, not the original bug).

## The rule going forward

When two functions are the two ends of one gesture (arm/fire, open/close, acquire/release), write the
**metamorphic property** that joins them before writing either function's example tests. If the
composition lives in an entrypoint closure, extract the seam first (`hover.ts` is the precedent).
A live check is done when the *outcome* is observed (the download), not when the first affordance
appears (the ring).
