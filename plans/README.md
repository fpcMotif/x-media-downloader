# Implementation plans

This folder holds four generations of plans. Plans 001–011 came from the
`improve-react` audit at commit `cf787c6`. Plans 012–023 came from the `improve`
performance audit at commit `7456911` on 2026-11-16. Plans 024–045 came from the
`improve` reliability and memory audit at commit `cee429a` on 2026-11-17. Plans
046–050 came from the `improve` effect and absence-type audit at commit
`2089ed0` on 2026-11-20.

Each executor: read the plan fully before starting, honor its STOP conditions,
and update your row when done.

Status values: TODO | IN PROGRESS | DONE | BLOCKED (with one-line reason) |
REJECTED (with one-line rationale) | REVERTED.

## Performance plans (012–023)

The audit covered the content script, the service worker, and the popup and
options pages. Nothing was measured at runtime. Every size of gain in these
plans is an estimate from reading the code.

The plans were written against a working tree with uncommitted changes on top
of `7456911`. Each plan's drift check uses `git diff --stat 7456911 -- <paths>`
so uncommitted changes show. Compare every excerpt with the live file before
editing.

| Plan | Title | Priority | Effort | Risk | Depends on | Status |
| --- | --- | --- | --- | --- | --- | --- |
| [012](012-skip-known-images-in-scroll-scan.md) | Skip already-resolved images in the X scroll scan | P1 | M | MED | — | TODO |
| [013](013-batch-hover-trace-events.md) | Stop hover traces from waking the worker and writing storage | P1 | S | LOW | — | TODO |
| [014](014-send-fetched-media-as-base64.md) | Send Fetched media to the offscreen document as base64 | P1 | S | LOW | — | TODO |
| [015](015-make-upload-chunker-linear.md) | Make the cloud upload chunker copy each byte once | P1 | S | LOW | — | DONE (review approved; commit `cee429a` on branch `advisor/015-make-upload-chunker-linear`, not merged) |
| [016](016-remove-mutation-response-listener.md) | Lock the mutation-response listener teardown with a test (the fix is already in the working tree, uncommitted) | P1 | S | LOW | — | TODO |
| [017](017-throttle-sync-panel-status-poll.md) | Pause the Sync panel poll when hidden and batch reconcile | P2 | S–M | LOW | — | TODO |
| [018](018-cache-settings-and-skip-noop-writes.md) | Cache settings in the worker and skip no-op storage writes | P2 | S | LOW–MED | — | TODO |
| [019](019-coalesce-history-and-ledger-writes.md) | Coalesce history writes and cache ledger reads | P2 | M | MED | 018 | TODO |
| [020](020-skip-unchanged-popup-metrics-renders.md) | Skip popup re-renders when metrics are unchanged | P2 | S | LOW | — | TODO |
| [021](021-defer-and-prefilter-tee-parsing.md) | Defer and pre-filter captured-response parsing | P2 | M | MED | 016 first | TODO |
| [022](022-maintain-capture-summary-incrementally.md) | Cache the capture summary and drop the per-batch count | P2 | S | LOW | — | TODO |
| [023](023-batch-sync-drains-and-outcome-broadcasts.md) | Batch sync drains and coalesce outcome tab queries | P3 | S | LOW | — | TODO |

### Recommended order

1. `016`, `015`, `013`. They are small, low risk, and independent.
2. `012`, then `014`.
3. `018`, then `019`.
4. `017`, `020`, `022`.
5. `021` after `016`.
6. `023` last.

### Dependency notes

- `019` requires `018`. It builds on the skip-unchanged-write rule that `018`
  adds to `runSerializedRmw` in `src/packages/kernel/durable-store.ts`.
- `021` and `016` both edit the `ctx.onInvalidated` block in
  `src/entrypoints/overlay.content/index.tsx`. Run `016` first, then `021`.
- `012`, `013`, `016` and `021` all edit
  `src/entrypoints/overlay.content/index.tsx`. Run them one at a time and rerun
  the next plan's drift check after each lands.
- `013`, `018`, `019` and `022` all edit `src/entrypoints/background.ts`. The
  same rule applies.
- `017` and `018` both edit `src/background/remote-upload.ts`. Run them one
  after the other.
- `src/entrypoints/background.ts` was changing while these plans were written.
  Plans `018` and `019` locate their edits by quoted text. In `013` and `022`,
  treat `background.ts` line numbers as approximate and match on the quoted
  code.
- Plan `007` (split the overlay controller) moves code that `012`, `013`, `016`
  and `021` edit. Run those four before `007`, then refresh `007`.

### Parts that need an owner decision first

- `020` Part B replaces the popup poll with a storage watch. ADR-0008 records
  that the popup polls. Do not execute Part B until the ADR is rewritten.
- `023` Part B stops at coalescing the tab query. A batched outcome message
  would contradict ADR-0014, which fixes one `TransferOutcome` per outcome.
- `014` keeps the fetch in the service worker because ADR-0003 records that the
  worker verifies the content type.

### Open questions found during planning, not verified

- `src/entrypoints/offscreen/main.ts:51` calls `browser.downloads.download`
  inside the offscreen document. Chrome documents offscreen documents as
  limited to `chrome.runtime`. Check Fetched mode in a real browser.
- `src/entrypoints/offscreen/main.ts:61` revokes the blob URL when the download
  starts, not when it finishes.

### Findings considered and rejected

- Detected Media Set grows during a long scroll on one route: "Download all"
  depends on the full set, so this is by design.
- Progress bar animates `width`: a comment in `src/components/ui/progress.tsx`
  records that the transform version was dropped on purpose for Base UI sizing.
- Lazy-loading the options panels: the gain is too small to plan.
- Popup bundle trimming (about 225 KB of script before first render): needs a
  bundle analysis before it can be planned honestly.
- Moving the Fetched-strategy fetch into the offscreen document: contradicts
  ADR-0003.
- Rate-limiting reconcile on cloud status reads: it would show stale status
  right after the user clicks Retry.
- Incremental capture counters: writes are merges that can replace a record, so
  counters would drift. `022` uses a cached fold instead.
- Byte cap on inline-JSON replay for Instagram and Threads: it could drop the
  first reel on a page.

### Not audited

The `clear` package internals, `src/packages/resolver`, the Convex `backend/`,
and every category other than performance.

## Reliability and memory plans (024–045)

The audit covered four areas: Release (the `clear` package and its worker
session), the capture archive and its search, cloud upload on both paths
(browser and Convex relay), and background memory. Nothing was measured at
runtime. Every size of gain in these plans is an estimate from reading the code.

The plans were written against a working tree with uncommitted changes on top
of `cee429a`. Each plan's drift check uses `git diff --stat cee429a -- <paths>`.
Compare every excerpt with the live file before editing.

Design constraint for every Release plan: the extension never sends X's GraphQL
requests itself and never replays credentials. It clicks X's own controls and
observes X's own requests through the page-world tee.

### Release (024–028)

| Plan | Title | Priority | Effort | Risk | Depends on | Status |
| --- | --- | --- | --- | --- | --- | --- |
| [024](024-gate-release-on-server-reply.md) | Let X's server reply decide a Release, not the optimistic DOM flip ([#98](https://github.com/fpcMotif/x-media-downloader/issues/98)) | P1 | M | MED | — | DONE (commit `318f880` on `main`) |
| [025](025-click-each-post-once.md) | Click each post's Release control once per attempt ([#99](https://github.com/fpcMotif/x-media-downloader/issues/99)) | P1 | M | MED | 024 | DONE (commit `e9706cd` on `main`) |
| [026](026-retry-stuck-releases.md) | Release posts whose files are saved but whose Release never finished ([#100](https://github.com/fpcMotif/x-media-downloader/issues/100)) | P2 | M | MED | 024, 025 | TODO |
| [027](027-pace-releases-and-back-off.md) | Stop clicking when X answers 429, and resume after a back-off ([#101](https://github.com/fpcMotif/x-media-downloader/issues/101)) | P2 | M | MED | 024, 025 | TODO |
| [028](028-drive-release-poll-from-worker.md) | Bound every release message and keep hidden-tab waits on time ([#102](https://github.com/fpcMotif/x-media-downloader/issues/102)) | P2 | M | MED | 024; run after 025, 027 | TODO |

### Capture archive (029–033)

| Plan | Title | Priority | Effort | Risk | Depends on | Status |
| --- | --- | --- | --- | --- | --- | --- |
| [029](029-export-one-thread-through-index.md) | A single-thread export reads only that thread ([#103](https://github.com/fpcMotif/x-media-downloader/issues/103)) | P1 | S | LOW | — | TODO |
| [030](030-summarize-captures-without-full-scan.md) | The capture summary reads a page of the archive, not every record ([#104](https://github.com/fpcMotif/x-media-downloader/issues/104)) | P2 | M | MED | 022 DONE; after 029 | TODO |
| [031](031-search-whole-archive.md) | Archive search covers every captured tweet ([#105](https://github.com/fpcMotif/x-media-downloader/issues/105)) | P2 | L | MED | 029 DONE; after 022, 030 | TODO |
| [032](032-stream-jsonl-export-in-page.md) | "Export all (JSONL)" travels in chunks ([#106](https://github.com/fpcMotif/x-media-downloader/issues/106)) | P2 | M | MED | 029, 031 DONE | TODO |
| [033](033-skip-unchanged-capture-writes.md) | Skip writes and mirror uploads for unchanged re-sightings ([#107](https://github.com/fpcMotif/x-media-downloader/issues/107)) | P2 | M | MED | —; one at a time with 022 | TODO |

### Cloud upload (034–040)

| Plan | Title | Priority | Effort | Risk | Depends on | Status |
| --- | --- | --- | --- | --- | --- | --- |
| [034](034-start-relay-lifetime-at-first-transfer.md) | Start the relay job lifetime at the first transfer ([#108](https://github.com/fpcMotif/x-media-downloader/issues/108)) | P1 | S | LOW | — | TODO |
| [035](035-remember-uploaded-media.md) | Remember uploaded media so pruning never causes a second upload ([#109](https://github.com/fpcMotif/x-media-downloader/issues/109)) | P1 | M | MED | — | TODO |
| [036](036-time-out-background-fetches.md) | Give every background fetch a timeout and unblock the Backfill reply ([#110](https://github.com/fpcMotif/x-media-downloader/issues/110)) | P1 | M | MED | — | TODO |
| [037](037-resume-browser-uploads.md) | Make browser uploads resumable and free of duplicate files ([#111](https://github.com/fpcMotif/x-media-downloader/issues/111)) | P2 | L | HIGH | 035, 036, 039 | TODO |
| [038](038-isolate-relay-reconcile-failures.md) | Keep one failed relay status call from stopping reconcile ([#112](https://github.com/fpcMotif/x-media-downloader/issues/112)) | P2 | S | LOW | —; after 017 | TODO |
| [039](039-pause-on-auth-and-honor-retry-after.md) | Pause a provider on lost authorization and honor Retry-After ([#113](https://github.com/fpcMotif/x-media-downloader/issues/113)) | P1 | M | MED | 036; after 035 | TODO |
| [040](040-verify-uploaded-bytes.md) | Verify that the provider stored the bytes the extension sent ([#114](https://github.com/fpcMotif/x-media-downloader/issues/114)) | P2 | M | MED | 037 (Parts A–D), 039 | TODO |

### Background memory (041–045)

| Plan | Title | Priority | Effort | Risk | Depends on | Status |
| --- | --- | --- | --- | --- | --- | --- |
| [041](041-let-worker-sleep-with-stalled-downloads.md) | Let the service worker sleep when only paused or purged downloads remain ([#115](https://github.com/fpcMotif/x-media-downloader/issues/115)) | P1 | S | LOW | — | TODO |
| [042](042-pause-page-observers-when-hidden.md) | Pause the saved-status sweep in hidden tabs ([#116](https://github.com/fpcMotif/x-media-downloader/issues/116)) | P2 | S | LOW | —; before 007 | TODO |
| [043](043-keep-tokens-out-of-watched-settings.md) | Keep tokens and secrets out of the settings key every page watches ([#119](https://github.com/fpcMotif/x-media-downloader/issues/119)) | P2 | S + M | LOW + MED | Part B: 018 DONE | TODO |
| [044](044-send-outcomes-to-owning-tab.md) | Send each transfer outcome to the tab that asked for it ([#117](https://github.com/fpcMotif/x-media-downloader/issues/117)) | P3 | S | LOW + MED | Part B: owner decision on ADR-0014 | TODO |
| [045](045-slim-content-script-bundles.md) | Take the Effect runtime out of the page-world script ([#118](https://github.com/fpcMotif/x-media-downloader/issues/118)) | P2 | S | LOW | —; baseline after 016, 021, 042 | TODO |

### Recommended order

1. `029`, `034`, `041`. They are small, low risk, and independent.
2. `024`, then `025`. These fix the Release root cause.
3. `036`, `035`, then `039`.
4. `042`, `038`, `033`.
5. `026`, `027`, then `028`.
6. `022` (from the earlier batch), then `030`, `031`, `032`.
7. `043` Part A, then `018`, then `043` Part B.
8. `037`, then `040`.
9. `044` Part A and `045` Part A at any point. Their later parts wait for an
   owner decision.

### Dependency notes

- `025`–`028` all build on the `startedAt` field and the changed `pollDomFlip`
  that `024` adds. `027` edits the `clickAndJudge` function that `025` adds.
- `024`, `025`, `027`, `028`, `042` and `043` edit
  `src/entrypoints/overlay.content/index.tsx`, as do `012`, `013`, `016` and
  `021`. Run them one at a time and rerun the next plan's drift check after
  each lands. Run all of them before `007`.
- `026`, `028`, `029`–`032`, `036`, `041`, `043` and `044` edit
  `src/entrypoints/background.ts`, as do `013`, `018`, `019` and `022`. The
  same rule applies. Locate edits by quoted text, not line number.
- `029`–`033` all edit `src/background/capture-db.ts`. `031` and `032` add
  message tags in `src/packages/schema/index.ts`.
- `030` replaces what the `summary()` cache from `022` holds. It stops if `022`
  is not DONE.
- `035`, `036`, `037` and `039` edit `src/background/cloud-upload.ts`, as does
  `019`. `035` and `037` both change the upload job schema.
- `038` edits `src/background/remote-upload.ts`, as do `017` and `018`.
- `043` Part B and `018` both edit `src/packages/settings/index.ts`.
- `044` Part B and `023` Part B rewrite the same `reportTransferOutcome` body.
  With `044` Part B done, `023` Part B saves little.
- `034` is backend-only. No plan deploys Convex code.

### Parts that need an owner decision first

- `034`: ADR-0013 says "one hour of total job lifetime" and does not say when
  the hour starts. The plan assumes the first lease grant and stops for
  confirmation.
- `044` Part B: ADR-0014 lists a targeted `TransferOutcome` send as a rejected
  alternative. Do not execute Part B until the ADR is rewritten.
- `045` Parts B and C: removing Effect Schema from the overlay script touches
  ADR-0004. Part B only measures. Part C is a design note.
- `030`: the order among conversations with an equal `lastAt` changes. The plan
  stops if a test pins that order.
- `033`: tweets stored before the mirror was enabled are no longer mirrored by
  an unchanged re-sighting. The plan stops if a spec or test promises that.
- `035`: whether the uploaded-media memory clears on provider disconnect.
- `037` Part E (resume from the confirmed offset) is the high-risk part and can
  be skipped. Lease renewal during long uploads is frozen by ADR-0020.
- `040`: a full hash for streamed Drive uploads over 8 MiB needs a streaming
  hash implementation or dependency.

### Open questions that need a live browser

- How long X takes between a Release click and its server reply. `024` uses a
  2 s grace as an injectable constant.
- Whether X sends the un-like and un-bookmark requests with a `Request` object.
  If it does, the tee cannot read the tweet id and the witness stays silent.
- What X returns for a post that is already released.
- Whether a second click on a stale row re-adds the post.
- Whether one paused download keeps the worker alive on the installed Chrome
  version (`chrome://serviceworker-internals`). `041` names the check.
- Whether Chrome ends the worker during a long upload that makes no extension
  API calls. This sizes `037`.

### Findings considered and rejected

- ADR-0021 drift (worker-authorized Scroll Drain is not wired; the hidden
  permalink tab does the work): a docs and dead-code decision for the owner,
  not planned.
- Pruning completed relay receipts: conflicts with ADR-0013, where receipts
  carry execution ownership and budget accounting.
- Storing a lowercased search field per record: needs an IndexedDB version
  bump. `031` uses a scan with a debounce instead.
- Opening IndexedDB directly from the options page for export: `022` stops on a
  second `indexedDB.open` site. `032` uses chunked messages.
- Dropping `rawText` from capture records: no reader was found, but it needs a
  migration decision.
- Loading only the current host's adapter in the page-world script: touches
  ADR-0019.
- `storage.local.setAccessLevel('TRUSTED_CONTEXTS')`: it also blocks the
  content script's own settings read.

### Found but not planned

- Offscreen document refcount race (`src/packages/download/fetched-strategy.ts`).
- Saved-index readers can answer before the boot seed lands
  (`src/entrypoints/background.ts`, `src/background/saved-status.ts`).
- Transfer ledger is persisted after a whole batch starts, not per download.
- Small leaks: `cloudGrabs`, saved-index `misses`, `orphanRecords`,
  `badgeNoKeyMedia`, and a key-set copy in the detection store.
- Relay: per-chunk call overhead, source 429 treated as permanent, one bad item
  rejecting a batch, expired source URLs, no backend sweeper for queued jobs.
- Drive folder paths are flattened on the relay and joined into one folder name
  in the browser.
- Convex hygiene: unbounded `.collect()` in `sync.ts`, uncapped `limit` in
  `captures.ts`, plain string comparison of the shared secret.
- Release: clear handlers that never reply on a throw, loops that keep clicking
  after the content script is invalidated, whole-list pass skipping rows that
  shift up, `dispatching` keyed by tweet id, correlation counters blind to
  witness-confirmed clears, and stale trust-boundary comments about forged
  mutation events.

### Not audited

Popup and options UI beyond the archive panel, `src/packages/resolver`, the
download queue internals, and tests as a category.

## Effect and absence plans (046–050)

The audit ran on 2026-11-20 at commit `2089ed0`, with uncommitted changes in
the working tree. It covered the popup, the options pages, and
`src/components`: every `useEffect`, every nullable `useState`, and a text
count of `| null` and `| undefined` under `src`. It ran React Doctor
(`bunx react-doctor@latest . -y --no-supply-chain --verbose`: score 67 of 100,
63 issues) and a `traits check` dry run (0 stored traits, so 0 checks).

`src/entrypoints/popup/App.tsx` was being edited while these plans were
written. Locate every edit in it by quoted text, not by line number.

| Plan | Title | Priority | Effort | Risk | Depends on | Status |
| --- | --- | --- | --- | --- | --- | --- |
| [046](046-remove-state-deriving-effects.md) | Six effects that only derive state are gone ([#120](https://github.com/fpcMotif/x-media-downloader/issues/120)) | P1 | M | LOW | — | DONE (commits `0d2caf6` and `3cc8c83` on branch `advisor/046-remove-state-deriving-effects`, not merged) |
| [047](047-load-mount-data-through-one-hook.md) | Mount-time data loads through one hook with a named state ([#121](https://github.com/fpcMotif/x-media-downloader/issues/121)) | P1 | M | LOW–MED | 046 | DONE (commit `b95702c` on branch `advisor/046-remove-state-deriving-effects`, not merged) |
| [048](048-name-nullable-ui-states.md) | Permission and connect state have named values, not `null` ([#122](https://github.com/fpcMotif/x-media-downloader/issues/122)) | P2 | S–M | LOW | 046, 047 | DONE (on branch `advisor/046-remove-state-deriving-effects`, not merged; grant states renamed to `no-origin`, `checking`, `granted`, `denied`, `check-failed`, `request-failed` at the operator's request) |
| [049](049-store-traits-for-semantic-lint.md) | The Traits semantic linter checks three stored rules ([#123](https://github.com/fpcMotif/x-media-downloader/issues/123)) | P2 | S | LOW | —; best after 046–048 | DONE (on branch `advisor/049-store-traits-for-semantic-lint`; first run: 12 fix, 9 check, 48 unsure, 84 pass) |
| [050](050-ratchet-null-and-undefined-unions.md) | The count of `\| null` and `\| undefined` unions can only go down ([#124](https://github.com/fpcMotif/x-media-downloader/issues/124)) | P2 | S | LOW | —; best after 046–048 | TODO |

### Recommended order

1. `046`, then `047`, then `048`. They edit the same files.
2. `050`, so the first budget already reflects 046–048.
3. `049` at any point once `TYPESAFE_API_KEY` is set.

### Dependency notes

- `046`, `047` and `048` all edit `src/entrypoints/options/panels/sync.tsx`.
  `047` and `048` both edit `saving.tsx`. `046` and `047` both edit
  `src/entrypoints/popup/App.tsx`. Run them one at a time and rerun the next
  plan's drift check after each lands.
- `017` edits the cloud status poll in `sync.tsx`. `020` and `022` edit the
  popup metrics and capture-summary paths. Run each next to the 046–048 group,
  not in parallel with it.
- `049` names `useLoaded` (from `047`) and `useOriginGrant` (from `048`) in
  trait guidance. It says what to drop when those plans are not DONE.
- After `050` lands, every plan that adds or removes a `| null` or
  `| undefined` union under `src` must update `scripts/absence-budget.json`
  in the same commit.

### Parts that need an owner decision first

- `050` counts every union and exempts nothing. Whether DOM, `browser.*`, and
  backend-JSON boundary lines are exempt is open.
- `049` assumes the default TypeSafe decision model and stops if
  `TYPESAFE_API_KEY` is unset. Adding `traits check` to the `check` gate or to
  `hk.pkl` is not planned, because each run costs model calls.
- `047` adds a visible failure line to the archive panel. The wording needs a
  review.

### Findings considered and rejected

- React Doctor `effect-needs-cleanup` at `src/entrypoints/popup/App.tsx:1343`
  (its one error): false positive. The effect clears its timer and an `active`
  flag, and `App.test.ts` pins both.
- React Doctor `no-unknown-property` ×23 in
  `src/entrypoints/overlay.content/index.tsx`: false positive. Preact accepts
  `class`.
- React Doctor `no-json-parse-stringify-clone` ×14: test files only.
- Removing the effects that own a timer, a DOM listener, or a poll
  (`confirm-strip.tsx` tick, Escape and outside-click listeners, focus on arm;
  the `hashchange` listener in `options/App.tsx`; `owned-timer.ts`; the cloud
  status poll; the popup metrics poll; `useLingeringValue`): each one
  synchronizes with an external system.
- Banning optional properties (`name?: T`): `exactOptionalPropertyTypes` is
  on, so an optional property already means "absent".

### Found but not planned

- Index used as a key at `src/components/ui/field.tsx:310` and an inline
  context value at `src/components/ui/toggle-group.tsx:135`. Both are real and
  small.
- `SyncPanel` and `SavingPanel` are reported as giant components. 046–048
  shrink them. A split is not planned.
- Nullable UI state left after `048`: the status-message slots
  (`string | null`) in the popup, the archive panel, the release panel and
  `capture-quick-actions.tsx`; `armedAt` in `confirm-strip.tsx`;
  `cloudStatus`, `relaySetup`, `metrics`, `tabAdapter`, `scope`; and
  `useLingeringValue`. They cross component boundaries and need their own
  plan.
- Nine `Option.getOrNull` / `Option.getOrUndefined` calls turn an `Option`
  back into a nullable value, for example
  `src/background/tab-broadcaster.ts:165` and
  `src/entrypoints/overlay.content/handlers.ts:666`.
- Per-module conversion of the 536 unions. `050` lists a starting order.

### Not audited

The 16 React Doctor `async-await-in-loop` and
`server-sequential-independent-await` warnings (in `backend/convex`,
`src/background`, and `src/packages/clear`), the overlay content script, the
background worker, the Convex backend, and every category other than effects
and absence types.

## improve-react plans (001–011)

All come from the vetted `improve-react` audit at commit `cf787c6`.
001–006, 009, and 010 are executed (landed on main via the PR-#55 absorb); 008
was landed and reverted (it broke the action-popup bubble — see the plan);
007 remains the one outstanding plan.

| Plan | Severity | Status | Depends on | Summary |
| --- | --- | --- | --- | --- |
| [001](001-block-forged-media-urls.md) | HIGH | DONE | — | Reject untrusted media URLs before storage, probing, or download. |
| [002](002-coalesce-pointer-hit-tests.md) | HIGH | DONE | — | Run at most one mouse hit-test per frame. |
| [003](003-own-saved-status-lifecycle.md) | MEDIUM | DONE | — | Gate, serialize, and dispose saved-status work and raw listeners. |
| [004](004-stop-popup-poll-after-unmount.md) | MEDIUM | DONE | — | Stop the popup metrics poll after unmount. |
| [005](005-announce-overlay-save-status.md) | MEDIUM | DONE | — | Expose badge and launcher progress to screen readers. |
| [006](006-debounce-video-recovery-scans.md) | MEDIUM | DONE | — | Move video recovery off every scroll frame. |
| [007](007-split-overlay-content-controller.md) | MEDIUM | NOT STARTED | 001, 002, 003, 005, 006; run after 012, 013, 016, 021 | Split the overlay view, interactions, capture, and message seams. |
| [008](008-support-320px-popup-reflow.md) | MEDIUM | REVERTED (broke the action bubble) | — | Let the popup reflow to 320 CSS px. |
| [009](009-replace-stale-feedback-timers.md) | LOW | DONE | 004 first | Cancel old feedback timers before rearming. |
| [010](010-name-sidebar-navigation.md) | LOW | DONE | 009 first | Name the Settings and Library navigation landmarks. |
| [011](011-extension-a11y-audit-and-reflow.md) | MEDIUM | DONE | — | Fix save-status live regions, WCAG 2.5.3 label matching, and bubble-safe popup shell. |

### Completion gate for 001–011

For every plan in this group:

1. Run its focused tests.
2. Run `bun run typecheck`, `bun run lint`, and `bun run build`.
3. Run `npx --yes react-doctor@latest . --scope changed`.
4. Confirm no new React Doctor issue and no lower score. Rule-backed plans must
   clear their named diagnostic.
5. Perform the plan's browser behavior check.
