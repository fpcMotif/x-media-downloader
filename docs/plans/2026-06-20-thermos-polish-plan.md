# Thermos Polish Plan — branch `refactor/detection-store`

**Status:** in progress · **Date:** 2026-06-20 · **Owner:** background/cloud surface
**Verdict carried in:** *"do not merge as-is"* (Thermos synthesis of two passes — branch audit + code quality).

This plan re-reports the synthesis findings **after verifying every one against the
real code** (10-agent audit, see below), corrects the severities the synthesis got
wrong, and sequences the fixes. It is the "document first" artifact: the
before-state is recorded here; the after-state (diffs + test results) is appended
under [After](#after) as each fix lands.

---

## How this was verified

Each synthesis claim was checked against `file:line` evidence rather than taken at
face value. The audit **upheld** the two HIGH security issues, **downgraded** two
"blockers" to low, and **refuted** one outright. The headline ("split `background.ts`
first") is a maintainability call, not the highest-*risk* item — the genuine
ship-blockers are a leaked write-secret and unauthenticated cloud reads.

## Corrected findings

| # | Finding | Synthesis said | Verified verdict | Sev | Disposition |
|---|---------|----------------|------------------|-----|-------------|
| 1 | **Dev-build secret embedding** — `WXT_CONVEX_SECRET` from `.env` is statically inlined into the shipped `background.js` | (lower-tier "then address") | **confirmed** — the live write-secret is baked into the built artifact when `.env` is present (`import.meta.env` is replaced at build time) | **HIGH** | **Fix now** |
| 2 | **Unauthenticated Convex reads** — `recentEvents` / `recentUploadJobs` queries skip the fail-closed secret gate the mutations enforce | flagged | **confirmed** — both public queries expose the entire sync/upload ledger on the discoverable `*.convex.cloud` URL | **HIGH** | **Fix now** |
| 3 | **Fetched-strategy memory** — full-body buffering OOMs the SW on large video | blocker | **confirmed** (worse: `Array.from(bytes)` adds an ~8× blow-up over the message boundary) | **MEDIUM** | **Fix now** |
| 4 | **No sender validation** on `runtime.onMessage` | flagged | **confirmed** — any other installed extension (and any content-script context on the page) can trigger downloads / OAuth / clears. (`externally_connectable` is unset, so *web pages* cannot.) | **MEDIUM** | **Fix now** |
| 5 | **Upload lease vs large video** — 120 s lease expires mid-upload → "duplicate uploads and lost ledger updates" | blocker | **partially-confirmed → LOW** — the fencing token prevents ledger corruption and the upload serial-queue prevents any same-SW-lifetime double-drain. The *only* residual harm is a duplicate **remote blob** across an SW recycle (the resumable session URL isn't persisted) | **LOW** | **Fix now** (one-line lease bump) |
| 6 | **`transfersState` lost-update race** — needs the serial-queue pattern | blocker | **refuted** as stated — every `transfersState` mutation is a *synchronous* compose on an in-memory var (no await between read and write-back), unlike the storage-RMW chains that genuinely need the queue. Real, smaller defect: a fire-and-forget `persistTransfers()` can land a **stale persisted snapshot last** | **LOW** | **Fix now** (serialize the persists only) |
| 7 | **In-memory-only clear ledger** — `clearLedger` Map lost on SW restart | flagged | **confirmed** — by design in v1 (the code comment names durable persistence + reconcile-on-boot as the follow-up) | **MEDIUM** | **Defer** (own spec-driven PR — irreversible-action risk) |
| 8 | **Missing SSRF guard on retry URLs** | flagged | **refuted** — the guard is deliberately scoped to the cloud *byte-fetch* path; `browser.downloads.download` (used by **both** the original and retry paths) is a different threat model. No differential exposure on retry | **LOW** | **Defer** (optional defense-in-depth; owner call) |
| 9 | **`background.ts` god-module** (~1,848 ln) | top blocker (structure) | **confirmed** — 7 extractable runtime modules, 5-stage low-risk-first order mapped | HIGH (maint.) | **Defer** (staged no-behavior-change PRs) |
| 10 | **`overlay.content/index.tsx`** (~1,394 ln) + duplicated media-plan / clear-scope | second blocker | **confirmed** — 8 cohesive clusters; media-plan insert **triplicated**, clear-scope policy reimplemented **3×** | HIGH (maint.) | **Defer** (staged + dedupe PR) |

### Why the decomposition is deferred, not done here

The synthesis is right that splitting the two god-files is the highest-*leverage*
structural move — but `background.ts` has **no test file** and the 100% coverage gate
only covers `src/core`. A 7-module extraction of a 1,848-line untested orchestrator,
bundled with correctness fixes, is exactly the change most likely to regress one of
its six load-bearing invariants (single `live` accumulator, shared correlation maps,
per-cluster serial queues, boot ordering, the await-before-sync recycle window, the
`.json` sidecar guard). Those extractions belong in their own behavior-preserving PRs,
each landing behind the coverage gate. The verified module maps are recorded in
[Appendix A/B](#appendix-a--backgroundts-decomposition-map) so that work is ready to
pick up.

---

## What lands in this pass

Ordered by severity, each fix is self-contained and testable:

1. **Convex read gate (HIGH).** Add `secret: v.string()` + `assertSecret(secret)` to
   `recentEvents` and `recentUploadJobs`; lift `uploads.ts`'s inlined check into a
   shared `assertSecret`. Update both convex-test files (the backend has its own
   coverage gate): thread the secret through the read tests + add a
   "rejects unauthenticated read" case per query.
2. **Dev-secret gate (HIGH).** Wrap the `WXT_CONVEX_URL`/`WXT_CONVEX_SECRET` env-seed
   block (`background.ts`) in `if (import.meta.env.DEV)` so a production `wxt build`
   tree-shakes the secret reference out of the bundle entirely. Verify by grepping the
   rebuilt `background.js`.
3. **Fetched OOM cap (MEDIUM).** Thread the existing Direct strategy into
   `makeFetchedStrategy`; surface `content-length`; route over-cap (and unknown-sized
   video) payloads to Direct (streams straight to disk, zero SW buffering) instead of
   buffering + `Array.from`-messaging them. Cover the new branches in
   `fetched-strategy.test.ts`.
4. **Sender validation (MEDIUM).** New pure `src/core/messaging/sender-guard.ts`:
   reject any sender whose `id !== runtime.id` (blocks other extensions); allow
   internal UI (popup/options, no `sender.tab`) any tag; restrict content-script
   senders to x.com/twitter.com origins **and** the content-script tag set
   (`DownloadRequest`, `DownloadTraceEvent`, `RecoverTweetMediaRequest`,
   `SweepEnqueueRequest`). Wire it at the top of the `onMessage` dispatch. Unit-tested.
5. **Upload lease (LOW).** Bump `LEASE_MS` 120 s → 600 s to match the MV3 5-minute SW
   hard cap, so the lease can't expire before the SW that holds it is itself killed —
   closing the cross-recycle duplicate-blob window without new machinery.
6. **`transfersState` persist ordering (LOW).** Route every transfers persist through
   one `makeSerialQueue`, the step reading the live var, so a late fire-and-forget
   write can't overwrite a newer snapshot. The two ordering-sensitive sites keep their
   await via `queue.run`.

### Tag classification (validated against real senders)

| Context | `sender.tab` | Tags it may send |
|---------|-------------|------------------|
| Internal UI (popup, options) | `undefined` | everything (incl. all Cloud*/Sync*/History/Clear*/Metrics) |
| Content script (overlay on x.com) | present, origin x.com/twitter.com | `DownloadRequest`, `DownloadTraceEvent`, `RecoverTweetMediaRequest`, `SweepEnqueueRequest` |

(`ClearVisibleRequest`/`DrainPageRequest`/`SweepPageRequest`/`ClearTweetRequest` go
popup→content via `tabs.sendMessage` and are handled by the overlay, never the
background — out of scope for the background guard.)

---

## Recommended merge sequence

1. **This PR** — the six correctness/security fixes above (small, tested, behavior
   scoped).
2. Durable clear ledger (#7) — its own spec-driven PR; the boot reconcile **must**
   re-verify bytes on disk before firing any clear (the action is irreversible).
3. `background.ts` decomposition (#9) — staged per Appendix A, one stage per PR, run
   `bun run test:all` after each.
4. `overlay.content` decomposition + dedupe (#10) — staged per Appendix B; the two
   dedupes (media-plan `DetectionStore.add/clear`, clear-scope `click-scope.ts`) land
   with the store/policy extractions.
5. Optional: SSRF defense-in-depth on the browser-download path (#8) — pure
   `assertAllowedMediaUrl` on **both** original and retry paths, only after confirming
   no legitimate non-`pbs/video.twimg` media host is downloaded that way.

---

## After

All six in-scope fixes landed. **Before → after** per fix:

1. **Convex read gate (HIGH).** `recentEvents` / `recentUploadJobs` now take
   `secret: v.string()` and call `assertSecret(secret)` first; `uploads.ts`'s
   inlined check was lifted into a shared `assertSecret`.
   - *Before:* `args: { paginationOpts }` → `handler` paginates with no auth.
   - *After:* `args: { paginationOpts, secret }` → `assertSecret(secret)` then
     paginate. Tests thread the secret through the read calls + a new
     "rejects an unauthenticated read" case per query.
   - Backend: **16 tests pass, 100% coverage** (`cd backend && bunx vitest run --coverage`).

2. **Dev-secret gate (HIGH).** The `WXT_CONVEX_URL`/`WXT_CONVEX_SECRET` env-seed
   block is wrapped in `if (import.meta.env.DEV) { … }`.
   - *Verified on a real production build* (`bun run build` with the populated
     `.env`): the secret **value = 0 occurrences** across the bundle;
     `WXT_CONVEX_SECRET` and `WXT_CONVEX_URL` env references = **0** in
     `background.js` (tree-shaken). The runtime `convexSyncSecret` settings field
     (the per-user options-page path) is untouched.

3. **Fetched OOM cap (MEDIUM).** `makeFetchedStrategy` gained `direct?` + `maxBytes?`
   (default `MAX_FETCHED_BYTES` = 96 MiB); `FetchPort` surfaces `contentLength`.
   Over-cap, or unknown-sized video, → `direct.save(req)` (browser streams to disk)
   instead of buffering + `Array.from`-messaging it. A post-buffer guard catches a
   lying/short `content-length`. Bounded sized images keep the verified path.
   - 4 new branch tests; `fetched-strategy.test.ts` **20 pass**, file at 100%.

4. **Sender validation (MEDIUM).** New pure `src/core/sender-guard.ts`
   (`isMessageAllowed`); wired at the top of the background `onMessage` router
   (`_sender` → `sender`). Foreign extension ids, off-origin content scripts, and
   UI-only tags from content scripts are dropped before any handler runs.
   - 11 unit tests covering every branch; file at 100%.

5. **Upload lease (LOW).** `LEASE_MS` 120 s → **300 s** (MV3 idle-SW cap), with an
   honest comment: within one SW lifetime the upload serial queue already prevents
   a concurrent re-claim, so the bump only narrows the rare cross-recycle
   duplicate-blob window (completed-but-unrecorded upload), at the cost of slower
   crash-recovery. Attempts still capped at `MAX_ATTEMPTS`.

6. **`transfersState` persist ordering (LOW).** All persists now go through one
   `transfersQueue` (`makeSerialQueue`); the step reads the live var at run time, so
   a late fire-and-forget write can't land a stale snapshot. The two terminal
   handlers keep their await via `flushTransfers()` (`queue.run`), preserving the
   recycle-re-fire-window guarantee.

### Verification summary

| Gate | Result |
|------|--------|
| `bunx vitest run src/core` | **657 pass** (incl. new sender-guard + fetched branches) |
| `bun run test:coverage` (src/core + src/lib) | **682 pass**; my files **100%** (the one 99.88% branch is `download/filename.ts:45`, a *pre-existing* gap from another tool's edit at 20:25, before this session — not from these changes) |
| `cd backend && bunx vitest run --coverage` | **16 pass, 100%** |
| `bun run build` (prod) | succeeds; secret tree-shaken (verified) |
| `tsgo --noEmit` | **clean for every file changed here**; the only 2 errors are in `popup/App.tsx`, which is being wholesale-rewritten by a concurrent tool (`exactOptionalPropertyTypes` on its new `usePageAction` `confirm` prop) — out of scope, left untouched to avoid clobbering live edits |

### Not touched (concurrent tool's live work — do not attribute to this change)

- `src/entrypoints/popup/App.tsx` — full popup redesign in progress (2 type errors).
- `src/core/download/filename.ts` + its test — modified at 20:25; introduced the one
  uncovered branch at `filename.ts:45`.

---

## Addendum — adversarial re-review (2026-06-21)

A second pass (4-lens adversarial workflow) re-verified the six landed fixes and the
session's follow-up claim *"offscreen listener hardened; no further follow-ups
required."* That claim was **half right**: the hardening exists but used the wrong
guard, and the severity was **over**-stated. One new fix lands here; two findings are
recorded as out-of-scope.

### Re-verified ground truth (all claims checked, not taken on faith)

| Gate | Claimed | Verified |
|------|---------|----------|
| `bunx vitest run src/core` | ~668 pass | **668 pass** (exact, pre-change) → **677** after this fix |
| `cd backend && vitest run` | 100% green | **16 pass** |
| `tsgo --noEmit` | clean | **clean for all in-scope files** (one error in `src/background/clear-coordinator.ts` is a *concurrent tool's* live decomposition WIP — untracked, unrelated, left untouched) |

### Finding #11 — Offscreen download sink under-guarded (LOW · fix now)

The plan's fix #4 (sender validation) was scoped to the **background router only**
("wire it at the top of the `onMessage` dispatch"). It never covered the **offscreen**
`runtime.onMessage` listener (`src/entrypoints/offscreen/main.ts:21`), which performs
`browser.downloads.download` with caller-supplied bytes + filename. The session patch
guarded it with `isFromOwnExtension` (**id-only**). That is insufficient:

- `runtime.sendMessage` is a same-origin **broadcast**; an *open* offscreen document
  also receives messages from our own **content scripts** (own id, but carrying a
  `tab`). `isFromOwnExtension` lets them through.
- The **only** legitimate sender of `OffscreenSaveRequest` is the background SW
  (`makeOffscreenPort.saveBlob`, `fetched-strategy.ts:246`), which has **no** `tab`.

**Severity: LOW** (downgraded from the session's MEDIUM). Bounded by: (a) the sink is
currently **non-functional** — `chrome.downloads` is unavailable inside an MV3
offscreen document, so `downloads.download` throws today (see Finding #12); (b) Chrome
rejects path-traversal filenames at the API level; (c) only our own **isolated-world**
content scripts on x.com/twitter.com can forge the message (a page XSS cannot reach
the isolated world); (d) the offscreen doc is only open briefly, on demand.

**Fix (landed):** new pure `isFromExtensionWorker(sender, ownId)` in
`src/core/sender-guard.ts` = own id **AND** no `tab` (mirrors the router's "internal
UI" tier, minus any content-script allowance). `offscreen/main.ts` now uses it; the
weaker `isFromOwnExtension` is removed (footgun — a too-weak shared guard inviting
reuse). Tested test-first (red → green): the load-bearing new assertion is *"rejects
our own content script (our id, but carries a `tab`)"*. `sender-guard.ts` stays at
**100%** (24/24 branches). Defense-in-depth: correct now, and correct when the sink is
revived (Finding #12).

### Threat-model correction (documentation)

`sender-guard.ts`'s header claimed foreign installed extensions were *"the real
surface"* for the router. That is wrong: a foreign extension's `sendMessage` reaches
`runtime.onMessageExternal` (which this extension never registers), **not**
`onMessage`; with `externally_connectable` unset, neither another extension nor a web
page can reach either router. The surface these guards actually govern is the
extension's **own** content scripts, confined to `CONTENT_SCRIPT_TAGS`. Header
comment corrected.

### Out-of-scope findings (recorded, not fixed here)

- **#12 — Offscreen `downloads.download` is non-functional (functional bug).**
  `chrome.downloads` is not exposed inside an MV3 offscreen document (only
  `chrome.runtime`), so the Fetched bounded-image save path silently fails today.
  Corroborates prior memory (`pr9-fetched-offscreen-rework`); a Design-B fix exists on
  branch `rework/offscreen-lifecycle`. Not a security item; tracked separately.
- **#13 — Overlay content listener unguarded (`index.tsx:1231`).** `handleRuntimeMessage`
  ignores `_sender`. Verdict **unguarded-low-reach**: a content script's `onMessage` is
  reachable only by the **same** extension (background `tabs.sendMessage`); no foreign
  extension or web page can deliver to it under MV3. The plan deliberately scoped these
  popup→content tags out (lines 84–93); the scoping holds. Optional belt-and-suspenders
  only — left as-is.

## Appendix A — `background.ts` decomposition map

7 modules, lowest-risk first. Each becomes a `make*(deps)` factory wired from
`defineBackground`.

- **Stage 1 (pure-move):** `core/sync/outbox-runner.ts` (outbox/syncStatus/drain/test),
  then `background/history.ts` (history item + `recordHistory`). Land history before
  upload (upload's backfill reads history).
- **Stage 2 (pure-move, 1 seam):** `background/cloud-upload.ts` (lines ~394–867;
  takes a `readHistoryRecords` callback; delegates `onAlarm`/`watchSettings`).
- **Stage 3 (seam — accumulator holder):** `core/download/metrics-monitor.ts` —
  encapsulate the module-level `let live`/`traceEvents`/`requestStartedAt` behind a
  holder before anything else consumes them.
- **Stage 4 (keystone):** `background/transfers.ts` + `background/clear-runner.ts` —
  the complete/fail outcome hub + boot reconcile + the clear ledger/worklist. Owns the
  shared `requestIdByDownloadId`/`inFlight`/`requestMetaById`. Inject monitor/sync/
  history/retry as callbacks.
- **Stage 5 (most-entangled):** `background/interrupt-retry-runner.ts` — bidirectional
  coupling with transfers; extract last, export `clearInterruptRetryState` back.

**Invariants that must hold or it's a regression, not a move:** single `live` owner;
correlation maps in one module; one serial queue per storage item (never merged);
`rehydrateInterruptRetries` before `reconcileTransfersOnBoot`; await the transfers
flush before sync/history writes; preserve the `.json` sidecar skip at every forwarded
id.

## Appendix B — `overlay.content/index.tsx` decomposition map

8 clusters, pure-relocation, lowest-risk first:

1. `core/adapters/x/hover-dom.ts` — `mediaAtPoint`/`videoAnchorAt`/`resolveHoverMedia`
   + hit-test helpers (pure DOM, happy-dom-testable).
2. `core/adapters/x/media-keys.ts` — `previewSrcFromMedia`/`previewKeyFromMedia`/
   `keysForItem`.
3. `core/detection/store.ts` — **DetectionStore** wrapping `byId`/`byKey`/
   `recoveredKeys`/`recoveryAttempted`. **Dedupe A:** the insert body is triplicated
   (`addDetectedItems` ≈ `onRescanClick` ≈ `ClearDetectedMediaRequest`); keep `add()`
   and `addRecovered()` **distinct** (their de-dup/photo-skip rules differ).
4. `core/clear/click-scope.ts` — `clearScope` + **Dedupe B:** the
   `pageScope + TWEET_ARTICLE_SEL` walk is reimplemented 3× (ClearVisible / SweepPage /
   ClearTweet) with **different pacing/strictness** — expose them as distinct entry
   points, not one merged fn.
5. `resetOverlayState()` — collapse the verbatim teardown sequence (3 copies).
6. `overlay.content/bg-bridge.ts` — egress wiring (`postEvent`/`sendTracked`/trace),
   carrying the `contextLostNotified` latch.
7. `overlay.content/ui/*.tsx` — `Overlay`/`BadgeButton`/glyphs as a pure view.
8. Last: split the 229-line `handleRuntimeMessage` god-switch into per-tag handlers —
   only after (3) and (4) exist, since the clear arms become thin callers.
