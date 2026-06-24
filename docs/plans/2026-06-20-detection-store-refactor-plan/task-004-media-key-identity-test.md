# task-004 — New-semantics tests for media-key identity (M3, RED)

Type: test · Depends on: 003 · Pairs with: task-004-impl · Behavior change: YES

## Context
M3 unifies `item.id` on PURE media-key. Pin the NEW behavior as tests before
changing the code.

## Scenario
- Same media from any source (tee / DOM / syndication) → ONE item (one id = key).
- The suspected tee-vs-DOM same-tweet photo double-count is now ONE (FIX test).
- The same image in two different tweets → ONE item; the LAST writer's
  `tweetId`/`index` win (documented last-writer semantics).
- Identity assertions: `resolveImageElement`, `resolveTweetMedia`, and the store
  all key by media-key (`id === mediaKey`).

## Implementation notes
- Update `src/core/adapters/x/detection-store.test.ts` (replace the M2
  characterization assertions that encode the dual scheme) AND add/adjust
  assertions in `xadapter.test.ts` / `resolver.test.ts` for `id === mediaKey`.
- These tests are RED until task-004-impl lands.

## Verification
```
bunx vitest run src/core/adapters/x src/core/resolver
# RED: new identity assertions fail against the still-dual-scheme code
```
Done when: the new-semantics tests exist and fail only because the impl hasn't changed.
