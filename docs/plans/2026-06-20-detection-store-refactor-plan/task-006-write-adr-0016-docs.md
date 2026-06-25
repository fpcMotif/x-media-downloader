# task-006 — Write ADR-0016 (media-key identity)

Type: docs · Depends on: 004 · Behavior change: documents it

## Context
The M3 identity unification is hard-to-reverse (it shapes durable download/outcome
ids), surprising (a future reader will ask why `id = mediaKey` and why the same
image downloads once), and a real trade-off — it clears the ADR bar.

## Scenario
- Given the media-key identity is implemented (task-004),
- When ADR-0016 is written,
- Then the decision, trade-off, and consequences are recorded in the repo's ADR
  format, matching docs/adr/0014/0015 style.

## Implementation notes — `docs/adr/0016-media-key-identity.md` must cover
- **Context:** `item.id` was a 3-scheme mess (tee media_id / DOM `${tweetId}-${index}`
  / bare key); the tee-vs-DOM divergence caused a suspected same-tweet double-count.
- **Decision:** unify all paths on PURE media-key; one index in the DetectionStore.
- **Trade-off (the surprising part):** the same image anywhere on a page downloads
  ONCE, filed under the last-writer tweet; Sweep/clear-on-save for that media key
  off the last-writer tweet. Chosen over the `${tweetId}:${mediaKey}` composite.
- **Consequences:** double-count fixed; SaveRequest.id stays unique (store collapses
  pre-queue); filenames unaffected (use tweetId+index, not id); CONTEXT.md **Media
  Key** term already landed.

## Verification
```
test -f docs/adr/0016-media-key-identity.md && echo OK
rg -n "Media Key" CONTEXT.md   # term present (landed in the grilling session)
```
Done when: ADR-0016 exists and covers Context / Decision / Trade-off / Consequences.
