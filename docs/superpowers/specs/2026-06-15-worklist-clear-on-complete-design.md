# Worklist Clear-on-Complete — Design Spec

- **Status:** Approved (design) — 2026-06-15
- **Topic:** Auto-remove an X post from the user's bookmarks/likes once *all* of its
  media has been truly downloaded, so those lists act as a self-emptying download
  worklist.
- **Supersedes/amends:** narrows ADR-0001 (read-only posture) for one write action;
  amends ADR-0005 (state placement). New ADRs: see §8.

## 1. Goal

Treat the user's **Bookmarks** and **Likes** as a download **Worklist**. When every
Media Item in a Tweet has *truly* landed on disk, the extension **Clears** that Tweet
from the Worklist (un-bookmark and/or un-like). The lists thereby empty themselves as
downloads complete.

A Tweet carries up to four photos **or** one video **or** one GIF (CONTEXT.md). All of
its Media Items must complete before it is Cleared; a partial Tweet is never Cleared.

## 2. Locked decisions

These were decided with the user and are not re-litigated here:

1. **Posture — full-auto, immediate.** The moment a Tweet is Truly Complete it is
   Cleared, with no per-post confirmation.
2. **Mechanism — DOM-click only (v1).** Clearing is a synthetic click on X's *own*
   native un-bookmark / un-like control, in-page. The authenticated mutation-replay
   path is **deferred** (see §9) — it would require net-new credential capture, an
   ADR-0001 amendment, an `x-client-transaction-id` we may be unable to synthesize, and
   carries materially higher account-ban risk.
3. **Activation — both.** (a) An always-on **Clear-on-complete hook** for any download
   the user triggers anywhere on X, and (b) an explicit **Drain** sweep on the
   bookmarks/likes page.
4. **Scope — both lists, on by default.** Un-bookmark and un-like are both enabled out
   of the box, each independently toggleable.
5. **Prerequisite — Truly Complete.** "Complete" means every Media Item reached the
   *real* `chrome.downloads.onChanged` terminal `complete` state. Any failure or
   interruption keeps the Tweet on the Worklist.

### Mechanism correction (recorded deliberately)

The initial framing that the replay path would "reuse the existing Auth-fallback
machinery" was **false** and was corrected during design. Verified against code:
`src/entrypoints/inject.content.ts:13-14` tees only response **bodies** (`{path, body}`)
and never reads outbound auth headers; `settings.authFallbackEnabled`
(`src/core/schema/index.ts:42`) is a stub that gates nothing today. Replay would be a
**net-new** capture of `bearer` + `ct0` (CSRF) + `x-client-transaction-id`. Hence v1 is
DOM-click only.

## 3. Domain nouns (to add to CONTEXT.md)

- **Worklist** — the user's Bookmarks or Likes, repurposed as a self-emptying download
  queue; the source list a Clear removes from.
- **Bookmark / Like** — a membership relation between the user and a Tweet (X's
  `Bookmarks` / `Likes` timelines). Distinct un-actions: Un-bookmark, Un-like.
- **Clear** — the write action that removes a Tweet from the Worklist by un-bookmarking
  and/or un-liking it. The project's **first** mutation of the user's X account;
  **irreversible**; only ever performed on a Truly Complete Tweet.
- **Truly Complete** — a Tweet whose *every* Media Item reached the real
  `chrome.downloads.onChanged` terminal `complete` state and has left the in-progress
  set. Defined in **explicit opposition** to the legacy start-time "saved" verdict (set
  when `chrome.downloads.download()` is merely *called* — the blind spot documented in
  `src/core/download/handoff.integration.test.ts:131-142`).
- **Completion Ledger** — the durable, per-Tweet record (expected / done / failed Media
  Item ids, scope, origin, per-scope clear latch) that is the **sole authority** gating
  a Clear. Survives service-worker recycle; reconciled against `chrome.downloads.search`
  on boot.
- **Clearer** — the component that performs a Clear. One interface, one v1
  implementation: DOM-click. (A replay implementation is deferred.)
- **Drain** — the user-started top-to-bottom sweep of a Worklist: download each Tweet,
  await Truly Complete, Clear while still mounted, scroll for more, repeat until empty.
- **Drain Cursor** — the persisted work-position of a Drain (scope, processed tweetIds,
  phase) that survives reload.
- **Membership** — the cached fact of whether a Tweet is currently Bookmarked and/or
  Liked, from the passive tee (`Bookmarks`/`Likes` ops) and live article state.
- **Clear Log** — the user-visible record of every Clear performed (tweetId, scope,
  mechanism, time, permalink). The **only** recovery surface for an irreversible action.

## 4. Architecture

New module group `src/core/clear/`, pure where possible, mirroring the existing
pure-state-machine idiom of `src/core/quickgrab.ts` and `src/core/badge.ts`.

### 4.1 Completion Ledger — `src/core/clear/ledger.ts`

A pure reducer. One entry per Tweet:

```
{
  tweetId, scope,            // bookmark | like | both (from Membership)
  origin,                    // hook | drain
  expected: Set<mediaId>,    // seeded BEFORE downloads fire
  done: Set<mediaId>,        // real onChanged 'complete', deduped (Set semantics)
  failed: Set<mediaId>,
  clear: {                   // per-scope latch — NOT a single boolean
    bookmark: 'none' | 'clearing' | 'cleared' | 'failed',
    like:     'none' | 'clearing' | 'cleared' | 'failed',
  }
}
```

- Dedupe `done`/`failed` by set membership (mirrors `src/core/metrics.ts:113`) so a
  duplicate `onChanged` can't make `done` exceed `expected`.
- **Per-scope latch** because a Tweet in both lists can have un-bookmark succeed while
  un-like fails; a single boolean cannot represent "bookmark cleared, like pending".

### 4.2 Truly Complete gate

A Tweet is **clearable** only when:

1. every `expected` id is in `done`, and
2. the download has fully **left the in-progress set** — confirmed via
   `chrome.downloads.search`, not the first `complete` delta. (A late `interrupted`
   after `complete` must not be able to retroactively undo an irreversible Clear.)

Any id in `failed` → not clearable; the Tweet stays on the Worklist.

**aria2 / external downloads are excluded** from auto-Clear: `background.ts:185-193`
records `complete` at hand-off, not bytes-to-disk, so treating them as Truly Complete
re-opens the blind spot. v1 excludes them and surfaces "downloaded, not auto-cleared".

### 4.3 Reconcile is the primary completion path

`onChanged` drops completions after a service-worker recycle
(`if (id === undefined || !live) return`, `background.ts:321`) and the
`downloadId → requestId → tweetId` map is in-memory only. Therefore:

- **Persist** the `downloadId ↔ tweetId` mapping alongside the Ledger.
- On SW startup/wake, `reconcile()` replays `chrome.downloads.search` terminal states
  into the Ledger.
- The live `onChanged` path is an optimization; correctness rides on reconcile. The
  Ledger handler must **not** depend on `live` being non-null.

### 4.4 Clearer — `src/core/clear/clearer.ts` (DOM-click only)

One interface `clear(tweetId, scope)`, single v1 implementation:

1. Find the Tweet's `<article>`; **guard:** confirm its resolved tweetId matches the
   Ledger entry before acting (defends against virtualization momentarily resolving the
   wrong id → wrong post un-bookmarked).
2. Locate X's native un-bookmark / un-like control via resilient `data-testid`
   selectors, falling back to the "…" caret menu.
3. Dispatch a real click; **verify the testid flipped** (or the article detached) before
   marking that scope `cleared`. No flip → `failed`, retried when next mounted.

### 4.5 Membership detection

For the hook, read the article's bookmark/like button state (`data-testid` /
`aria-pressed`) to decide whether and which scope to Clear, backed by the tee's
already-captured `Bookmarks`/`Likes` facts. If the Tweet is **not currently mounted**,
the hook **defers** — DOM-only cannot click an unmounted button; it Clears next time the
post is seen or on the next Drain.

### 4.6 Two activations, one atomic transition

- **Clear-on-complete hook** (always-on): any download → on Truly Complete, if the post
  is mounted and on the Worklist, Clear it.
- **Drain** — `src/core/clear/drain.ts`, orchestrated from the content script: walk the
  page top-to-bottom — download each Tweet → await Truly Complete → Clear *while
  mounted* → scroll for more → repeat until empty. A persisted **Drain Cursor** survives
  reload; a **watchdog** times out stalled scroll/await phases.
- **Both funnel through one compare-and-set** on the per-scope latch: claim `clearing`
  **before** the click, resolve to `cleared` only on confirmed flip. The Ledger is
  written through a **single serialized read-modify-write chain** (the same single-writer
  pattern the background already uses for its outbox/history writes) so interleaved SW
  events and the hook-vs-Drain pair can never double-fire on one Tweet.

## 5. Failure matrix

| Scenario | Behavior |
|---|---|
| 3 of 4 photos land, 1 fails/interrupts | Not Cleared; Tweet stays; failed item re-downloadable. |
| Clear-click fires but button not found / testid didn't flip | Scope `clearing` → `failed`; retried when next mounted; never marked cleared. |
| Tweet in both lists; un-bookmark ok, un-like fails | `bookmark: cleared`, `like: failed`; no double-unbookmark on retry; not done until both resolve. |
| User manually re-bookmarks right after auto-Clear | Latch is `cleared` → we do not re-Clear; never fight a deliberate user action. |
| Virtualization resolves wrong tweetId | id-match guard aborts the click → no wrong post un-bookmarked. |
| Browser closed mid-Drain | Drain Cursor + Ledger (storage.local, §7) survive → resumes / re-evaluates on restart. |
| Download via aria2 | Excluded from auto-Clear; surfaced as "downloaded, not auto-cleared". |
| Double `onChanged` for one id | Set-membership dedupe in the Ledger. |
| `complete` then late `interrupted` | Gate waits for the download to leave the in-progress set, so the Clear never fired. |

## 6. Anti-abuse pacing (v1 circuit breaker)

Even DOM clicks: a Drain clicking un-bookmark as fast as the scroller loads rows is a
non-human cadence. Clears go through:

- a **single-flight queue**,
- a **minimum jittered delay** — default **2–4 s** between Clears,
- **per-minute and per-session caps** — Drain default cap **~200 / session**,
- **abort-and-backoff** if X starts erroring or buttons stop flipping.

## 7. State placement

The Ledger holds *"Truly Complete but not yet Cleared"* intent for an **irreversible**
action. `storage.session` wipes on browser close (ADR-0005); losing that fact means a
post never Clears or is re-downloaded-and-Cleared. Therefore:

- **Completion Ledger → `storage.local`** (durable; pruned after successful Clear).
- Drain Cursor + Membership cache may stay in `storage.session`.

This amends ADR-0005 ("Captures → session / no persistent download history in v1").

## 8. Irreversibility surface

Because the action is on-by-default and has no undo:

- **First-run announcement** — the first time it would Clear: a one-time "*This starts
  removing posts from your bookmarks/likes as they finish downloading — [Keep on] /
  [Turn off]*". Informs without begging permission (stays true to on-by-default).
- **Kill switch** — per-scope toggles (default on) + a master pause.
- **Clear Log** — a persisted, popup-visible record of every Clear (tweetId, scope,
  mechanism, time, permalink). Each entry links back so the user can manually re-bookmark
  / re-like. This is what makes "irreversible + on-by-default" survivable.

## 9. Docs & ADR impact

- Add the §3 nouns to **CONTEXT.md**.
- **ADR-0015 — Clear-on-complete (DOM-click):** the project's first write action
  (synthetic click on X's own control), full-auto, gated on Truly Complete; narrowly
  annotates ADR-0001's read-only framing and folds in the §6 pacing policy.
- **ADR-0016 — Completion Ledger persistence:** durable `storage.local` Ledger,
  persisted `downloadId ↔ tweetId` map, reconcile-as-primary; amends ADR-0005.
  *(ADR numbers provisional; 0011–0014 already exist.)*
- **Deferred ADRs** (written only if/when replay is built): authenticated-replay
  Clearer, its own consent flag (not the read flag), auth-header capture boundary,
  write-pacing circuit breaker.

## 10. Testing strategy

- **Pure units:** Ledger reducer (Truly Complete, per-scope latch, dedupe, aria2
  exclusion, late-interrupt-after-complete), Drain cursor machine, Clearer decision
  logic. **Every race the grill found becomes a named test** (double-`onChanged`,
  sweep-vs-hook double-fire, wrong-id guard, partial-scope clear).
- **Integration:** give the documented blind-spot test
  (`handoff.integration.test.ts:131-142`) a real completion path through the Ledger.
- **Manual / e2e:** X's live DOM + virtualization (un-coverable by units) — handled by
  the prototype.

## 11. Prototype plan

Two throwaway spikes; **neither fires destructive live writes at scale**:

1. **Ledger state-machine prototype** — a runnable terminal model driving the Ledger
   through Truly Complete, partial failure, double-`onChanged`, late-interrupt,
   sweep-vs-hook race, per-scope partial Clear. Proves the logic before Chrome wiring.
2. **X DOM probe** — *read-only* on a real bookmarks/likes page: confirm the current
   un-bookmark / un-like `data-testid`s, the "…" caret-menu structure, and how
   virtualization mounts/unmounts articles + whether tweetId resolution stays stable.
   **Also settles definitively whether bookmarks/likes merged into a "history"
   surface.** No clearing clicks; a single deliberate manual-unbookmark test on a
   throwaway bookmark comes later.

## 12. Risks & open items

- **Selector rot:** X's `data-testid`s for un-bookmark/un-like and the caret menu can
  change; the Clearer must fail safe (never mark cleared without a verified flip).
- **Ban risk residual:** even DOM clicks at Drain scale are a behavioral anomaly; §6
  pacing is load-bearing, defaults need empirical confirmation during the prototype.
- **aria2 users** get no auto-Clear in v1 (deliberate); revisit with an aria2 completion
  poll later.
- **Replay path** remains desirable for off-screen/queued posts; deferred behind its own
  ADR + consent + circuit breaker, contingent on the `x-client-transaction-id` question.
