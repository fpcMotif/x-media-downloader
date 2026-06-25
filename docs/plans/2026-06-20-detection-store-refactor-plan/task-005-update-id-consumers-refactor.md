# task-005 — Update id consumers and split('-') test helpers; re-verify (M3)

Type: refactor · Depends on: 004 · Behavior change: follows 004

## Context
With `id = mediaKey`, re-verify every downstream id consumer stays correct and fix
the two TEST helpers that assume the old `${tweetId}-${index}` scheme.

## Scenario
- Given id is now media-key,
- When the id consumers are reviewed,
- Then download→outcome correlation, RefreshMediaUrl matching, the `${id}.json`
  sidecar, and history mirroring all still behave correctly, and the test helpers
  no longer parse the id scheme.

## Implementation notes / checklist (verified scheme-agnostic during grilling — confirm)
- `SaveRequest.id` / `TransferOutcome.requestId` correlation (ADR-0014): consistent
  by construction (both use the new id).
- `RefreshMediaUrl`: exact-id match + `(tweetId,index,type)` fallback — both fine.
- Sidecar `${item.id}.json` (download/destination.ts): unique with media-key.
- `isMirrorableRequest` (history/wiring.ts): only checks `!endsWith('.json')` — safe.
- FIX: `src/core/history/store.test.ts:8` and
  `src/entrypoints/popup/history-section.test.ts:10` do `id.split('-')[0]` — update
  these fixtures to not assume the old scheme.

## Verification
```
rg -n "id\.split\('-'\)" src    # only intended/updated occurrences remain
bunx vitest run                  # full suite green (incl. download↔outcome correlation)
bun run check                    # typecheck + lint + format + tests
```
### MANUAL GATE (loop pauses here — human required)
`/verify` on https://x.com/ooaoau/status/2068286123399676218: correct count,
working video download, NO double-count on a multi-photo tweet, and the badge shows
the REAL terminal outcome (ADR-0014 correlation intact).
Done when: consumers verified, helpers fixed, suite + check green, AND manual /verify passes.
