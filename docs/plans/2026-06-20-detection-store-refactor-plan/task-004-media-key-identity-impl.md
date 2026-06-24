# task-004 — Unify item.id on pure media-key (M3, GREEN)

Type: impl · Depends on: 003 · Pairs with: task-004-test · Behavior change: YES

## Context
Collapse the dual id/key model: every detection path assigns `id = mediaKey`.

## Scenario
- Given the new-semantics tests (task-004-test),
- When every path keys by media-key and the store uses a single index,
- Then the tests pass and the suspected double-count is gone.

## Implementation notes
- `resolveTweetMedia` (tee photos/videos), `resolveImageElement` (DOM photos),
  and the syndication path all set `id = mediaKey` (derive via `mediaKeyFromUrl`
  from the resolved url/previewUrl). Keep `tweetId` + `index` as fields (filenames
  use them — `download/filename.ts` — NOT the id).
- Collapse the store to a single media-key index (the recoveredKeys guard becomes
  trivial once id IS the key; keep `recoveryAttempted` as the per-tweet fetch guard).
- Accepted semantics: same image anywhere on a page → one item/one download, filed
  under the last-writer tweet. No SaveRequest.id collision (store collapses pre-queue).

## Verification
```
bunx vitest run src/core/adapters/x src/core/resolver   # GREEN
bun run test:coverage   # src/core 100% branches
bun run typecheck
```
Done when: task-004-test passes, coverage holds, typecheck green.
