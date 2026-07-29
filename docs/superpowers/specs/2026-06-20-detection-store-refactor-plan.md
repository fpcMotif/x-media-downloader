# DetectionStore refactor — plan (grilled 2026-06-20)

> **STATUS 2026-07-05: EXECUTED.** M1+M2+M3 all landed (src/core/adapters/x/detection-store.ts,
> ADR-0016); verified complete in the round-4 architecture review. Do not re-open or re-scope.

Executable plan for a code-quality refactor of the **syndication video-recovery**
feature (ADR-0015) and the overlay detection state it touches. Produced by a
`/grill-with-docs` session; every design fork below was decided with the user.
An executor with no memory of that session can act from this file alone.

## Why (context)

ADR-0015 added a syndication fallback so a tee-missed X video is counted and
downloadable. An adversarial review (6 agents) found **0 correctness bugs** — the
dedup, lifecycle, and wiring are sound. So this is a **quality** pass, not a fix.
The smells it targets:

- The subtle recover/dedup logic lives **untested** inside the overlay
  god-module (`src/entrypoints/overlay.content/index.tsx`); the review had to
  hand-trace 5 invariants because none are unit-tested.
- Detection state is **four loose containers** in the overlay closure: `byId`,
  `byKey`, `recoveredKeys`, `recoveryAttempted`.
- `item.id` is **already a 3-scheme mess**: `media_id_str` (tee), `${tweetId}-${index}`
  (DOM `resolveImageElement`), bare media-key (anchor-less quote card). The tee vs
  DOM divergence is a **suspected same-tweet double-count** (two ids for one photo).

## Decided design (the grilled forks)

1. **Sequencing:** staged — polish, then extract. → three isolated milestones (#6).
2. **Seam:** a **full DetectionStore** that owns ALL four containers (not a minimal
   recovery-only coordinator). Chosen over feature-scoped because half-extracting
   leaves the dedup invariant straddling two owners.
3. **Identity:** **unify** (not behavior-preserving) — collapse the dual id/key model.
4. **Identity grain:** **pure media-key** (`id = mediaKey`), chosen over the
   `${tweetId}:${mediaKey}` composite. Consequence the user accepted: the same image
   anywhere on the page downloads **once**, filed under whichever tweet surfaced it
   **last** (last-writer wins on `tweetId`/`index`). No SaveRequest.id collision —
   the store collapses to one item _before_ the Start Queue.
5. **Sequencing of the behavior change:** **three isolated milestones** so a
   count/download regression bisects to exactly one.

## Load-bearing facts verified during grilling (don't re-discover)

- **No production code parses the id scheme.** `isMirrorableRequest` (history/
  wiring.ts:16) is just `hasMediaItem && !requestId.endsWith('.json')`. Nothing
  reconstructs `tweetId` from `id`. Only two TEST helpers do `id.split('-')`
  (`src/core/history/store.test.ts:8`, `src/entrypoints/popup/history-section.test.ts:10`)
  — update these in M3.
- **id consumers** (must stay consistent, all scheme-agnostic): `SaveRequest.id`
  (download), `TransferOutcome.requestId` correlation (ADR-0014), `RefreshMediaUrl`
  exact-id match with a `(tweetId,index,type)` fallback (`download/url-retry.ts`),
  sidecar `${item.id}.json` (`download/destination.ts:66`).
- **Filenames use `tweetId`+`index`, never `id`** (`download/filename.ts`) — so
  changing `id` does NOT affect filenames; keep `index` on the item.
- **Overlay call-site inventory** (M2 repoints these): `byId` ×21
  (size×5, values×4, has×3, set×3, clear×2, get×1), `byKey` ×14
  (set×3, clear×2, keys×1, get×1, has×1), `recoveredKeys`/`recoveryAttempted` ×13.
  Spread across hover (`byKey.get`), download-all/Drain/Sweep (`byId.values`),
  RefreshMediaUrl (`byId.get`), launcher count (`byId.size`), clear handlers.
- **Pure helpers to reuse, not reinvent:** `videoTweetsNeedingRecovery`,
  `playerPosterUrl`, `resolveTweetMedia`, `parseSyndicationTweet`, `mediaKeyFromUrl`,
  `keysForItem` (move this into the store module).

## Milestones — each loop-verifiable

### M1 — In-place polish (zero behavior change)

1. Track `settleRenderedScan`'s two timers in a handle array; clear them in
   `ctx.onInvalidated`, matching every other timer in the file.
   - verify: `rg "setTimeout\(" src/entrypoints/overlay.content/index.tsx` shows
     only the `await new Promise(r => setTimeout(r,…))` sleeps as bare; the
     `onInvalidated` block clears the settle timers.
2. SKIP the `keysForItem`→`[]` host-check (review finding 3): unreachable with
   trusted X data; record as explicitly out of scope in the commit message.

- M1 done: `bun run typecheck && bun run lint && bunx vitest run` green; `git diff`
  shows only timer-tracking (no logic change).

### M2 — Behavior-PRESERVING DetectionStore extraction

1. Create `src/core/adapters/x/detection-store.ts`: `makeDetectionStore()` owning
   `byId`+`byKey`+`recoveredKeys`+`recoveryAttempted` with **identical** dual-index
   semantics. API from the call sites: `addDetected(items): MediaItem[]`,
   `addRecovered(items): MediaItem[]`, `needsRecovery(root): string[]` (wraps
   `videoTweetsNeedingRecovery` with its own keys), `resolve(key)`, `get(id)`,
   `values()`, `valuesForTweet(tweetId)`, `count`, `clear()`. Move `keysForItem` in.
2. Repoint all ~35 overlay call sites to the store; delete the loose closures.
   - verify: `rg "\b(byId|byKey|recoveredKeys|recoveryAttempted)\b" src/entrypoints/overlay.content/index.tsx`
     returns 0; `bun run typecheck` green (compiler proves every site moved).

- M2 done: `detection-store.test.ts` ports the review's 5 invariants as
  **characterization** tests (CURRENT behavior, incl. the suspected double-count
  UNCHANGED) + every query method; `bun run test:coverage` keeps `src/core` at 100%
  branches (modulo the concurrent-tool `filename.ts:45` gap, see Caveats); `/verify`
  run on the bug tweet shows the SAME count + working download/hover/recovery.

### M3 — Unify identity on media-key (behavior change; ADR'd)

1. Every path assigns `id = mediaKey` (tee photo/video via `resolveTweetMedia`, DOM
   via `resolveImageElement`, syndication); collapse the store to a single
   media-key index.
2. Rewrite the store tests for new semantics: same media (any source) counts once;
   same image in two tweets → one item (last-writer tweet wins); a FIX test proving
   the tee-vs-DOM same-tweet double-count is now one.
3. Re-verify id consumers (list above); update the two `id.split('-')` test helpers.
   - verify: download→outcome correlation test green; `/verify` queues a recovered
     video + a photo and confirms the badge shows the REAL terminal outcome
     (ADR-0014 path intact).
4. Write `docs/adr/0016-media-key-identity.md`: media-key choice, the cross-tweet
   collapse + last-writer-filename trade-off, consequences. (CONTEXT.md **Media
   Key** / **Detected Media Set** terms already landed in this session.)

- M3 done: `bun run check` green; `/verify` on
  https://x.com/ooaoau/status/2068286123399676218 shows correct count, working
  video download, no double-count on a multi-photo tweet, intact correlation.

## Caveats / known edges

- **M3 is the only behavior change.** M1+M2 are safe to land regardless; if M3's
  cross-tweet/last-writer semantics ever feel wrong, it reverts without touching
  the extraction.
- **Concurrent tooling** edits this repo live (e.g. `download/filename.ts` was mid-
  rewrite, leaving `filename.ts:45` uncovered — not ours). Re-check mtimes; the
  global coverage gate may be red for reasons outside this plan.
- `/verify` (real-extension) steps need a browser; they can't be satisfied by the
  unit suite alone.

## Definition of done

All three milestones' "done" gates pass, including the two `/verify` runs, and
ADR-0016 + the CONTEXT.md terms are in place.
