# Clear safety circuit and recovery log

**Date:** 2026-07-18

**Status:** Accepted after adversarial revision

## Problem

Clear mutates the user's X account. The durable Completion Ledger prevents a
wrong or repeated Clear, but it does not bound cadence. A Drain could still click
at machine speed after a worker restart. The approved Worklist design also
requires a durable, user-visible record of every verified Clear.

## Boundary

`ClearCoordinator` remains the only component allowed to authorize a Clear. It
uses a separate, pure `ClearSafetyCircuit` before it changes a ledger scope from
`reserved` to `attempted`.

The circuit owns cadence and abuse limits. It does not inspect DOM state,
settings, or download completion. The Completion Ledger still owns authority.
The modules are separate. Their durable state is not: one `xmd-clear` IDB
transaction makes issuance and outcome feedback atomic.

Verified Clear history is derived from Completion Ledger tombstones. It is not a
second writable log. This keeps the mutation proof and recovery record in one
durable write.

## Safety state

```ts
interface ClearSafetyState {
  readonly version: 1
  readonly nextAttemptAt: number
  /** Every destructive issuance in this browser session; bounded to 200. */
  readonly attemptAts: ReadonlyArray<number>
  readonly browserSessionEpoch: number
  readonly failureStreak: number
  readonly backoffLevel: number
  readonly blockedUntil: number
}

interface ClearCoordinatorStore {
  readonly version: 1
  readonly completion: ClearLedgerStore
  readonly safety: ClearSafetyState
}

type ClearSessionMarker =
  | { readonly version: 1; readonly browserSessionEpoch: number }
  | {
      readonly version: 2
      readonly browserSessionEpoch: number
      readonly baseRevision: number
      readonly baseAttemptAts: ReadonlyArray<number>
    }
```

The `active` record in IndexedDB `xmd-clear` survives worker, extension, and
browser restarts. `session:clearSessionMarker` is only a boot marker. IDB remains
the budget authority. The exact session-gate protocol below prevents extension
reloads, updates, concurrent startup contexts, or a late startup event from
resetting that budget twice.

The codec is exact and fail closed. It rejects unknown versions or keys,
unsafe timestamps, unsorted attempts, more than 200 attempts, invalid session
epochs, and out-of-range backoff levels. A future attempt after wall-clock
rollback remains authoritative; Clear waits past its exact timestamp.
Corruption blocks destructive sends. It never gets replaced with an empty state.
A valid legacy Completion Ledger may be imported once into this wrapper. An
invalid legacy value is not migrated.

## Exact limits

Each `ClearTweetRequest` carries one destructive scope. Two scopes on the same
post therefore receive the same pacing as two different posts.

- One destructive request at a time.
- Random delay of 2,000–4,000 ms from one request's terminal reply to the next
  destructive request.
- At most 20 attempted scopes in any rolling 60,000 ms.
- At most 200 attempted scopes per browser session.
- Three consecutive `preflight-failed` or `uncertain` outcomes trip backoff.
- Backoff levels are 15, 30, then 60 minutes. Later incidents stay at 60 minutes.
- A verified `cleared` result resets the failure streak. Safe no-ops are neutral.

Twenty attempts per minute is stricter than the two-second floor alone. Counting
attempts, not successes, is load-bearing: a lost reply may hide a successful
account mutation.

## Issue protocol

The coordinator reserves one actionable scope first. It waits outside the settings
turn. When due, it enters `withClearPolicyTurn` and performs this sequence without
yielding mutation authority to another settings write:

1. Read fresh settings. If policy is off, atomically release the reservation and
   return without consuming budget.
2. Recheck `nextAttemptAt` and `blockedUntil`; leave the scope reserved if early.
3. Count the suffix of `attemptAts` inside the last 60 seconds.
4. Refuse at 20 recent attempts or 200 total session attempts.
5. In one strict IDB transaction, append the attempt and change the ledger scope
   to `attempted`.
6. Send exactly once while still holding the settings policy turn.
7. In one coordinator-state write, persist the exact result, tombstone, circuit
   feedback, and `nextAttemptAt = terminalAt + random(2,000..4,000)`.

The pre-send write is conservative. A crash or storage failure may consume budget
without sending. It cannot send without consuming budget. A failed write grants no
mutation authority. A crash after send but before the result write recovers the
persisted `attempted` scope as `uncertain`; that same recovery transition updates
the tombstone, failure streak, backoff, and next deadline atomically.

When a deadline blocks a ready scope, the coordinator retains it and schedules a
wake. Short jitter uses an in-worker timer. Longer rolling/backoff waits use one
named Chrome alarm. The absolute deadline remains durable; lost timers or alarms
are harmless because boot and visibility pulses recheck it. In-worker timers use
bounded hops and reread wall time after every callback; a signed-32-bit timer
overflow or clock rollback cannot satisfy a future deadline early.

The minute cap schedules a wake for its oldest included attempt's expiry. The
session cap has no timed reset. Ready scopes remain durable while capped.

## Browser-session gate

No destructive drive may run until this gate opens:

1. If the exact session marker matches the local `browserSessionEpoch`, open
   without changing the budget. This is an ordinary worker recycle.
2. If the marker is missing or mismatched, hold every automatic boot drive.
3. A `runtime.onStartup` event writes a version-2 claim first. The claim fixes
   the target epoch, base revision, and exact old attempt prefix.
4. Through IDB CAS, remove only that bound prefix and increment to the fixed
   epoch. Attempts appended after the claim survive every retry. A concurrent
   winner or later worker completes the same claim.
5. After commit, replace the claim with the matching version-1 open marker.
6. An external wake may win first, as happens after an extension reload or update.
   It adopts the existing local epoch, writes the matching marker, and opens without
   clearing attempts. A later `onStartup` event is ignored for that worker life.
7. If either path fails, keep the gate closed. A missed browser-start reset can
   over-count into the next session. It can never under-count the current one.

Listeners register synchronously before boot begins. Completion reconciliation may
update download proof while the gate is pending, but Locate and destructive drive
wait. Boot recovery of `attempted` also finishes before the gate opens.

## Outcome feedback

The exact Clear reply and circuit feedback are one coordinator-state transition:

- `cleared` resets `failureStreak` to zero.
- `preflight-failed`, `uncertain`, and a lost or malformed reply increment it.
- At three failures, set `blockedUntil`, increment `backoffLevel`, and reset the
  streak.
- `already-clear` and `not-actionable` do not consume or reset the failure streak.

The attempted send already consumed cadence and budget regardless of its result.
Backoff affects later scopes only. There is no cross-store replay gap: a terminal
ledger result cannot exist without its matching safety transition.

If the terminal coordinator-state write rejects, the worker retains the exact reply
and retries that same result transition. Until it persists, a volatile fail-stop
latch rejects every later destructive drive. This preserves a verified `cleared`
result and its log entry. Only a new worker, which no longer knows the reply, may
recover the durable Attempted scope as `uncertain`. Recovery finishes before its
session gate opens. A write outage can stop Clear, but cannot erase known proof or
let a sibling bypass pacing or backoff.

## Clear Log

`resolveAttemptedClear(..., result: 'cleared')` writes a `cleared` tombstone at the
exact verified time in the same Completion Ledger transition. `uncertain` also
gets its safety tombstone but never appears in the user log.

An entry may temporarily retain a terminal scope while another scope is pending.
The codec permits an overlapping tombstone only when the entry's terminal state
matches it exactly. Every mismatch is corruption.

```ts
interface ClearLogRecord {
  readonly tweetId: string
  readonly scope: Scope
  readonly mechanism: 'dom-click'
  readonly at: number
  readonly permalink: string
}
```

The `by_cleared_time` IDB index reads cleared tombstones newest first.
Permalinks are `https://x.com/i/status/{tweetId}`. Tombstones do not expire.

`ClearLogRequest` returns the recent projection through an exact tagged reply.
The popup shows the latest verified Clears with scope, time, and permalink. It
shows unavailable separately from an empty log. No Clear-log reset is coupled to
the Download Monitor, History, Worklist, or Completion Ledger reset.

## Composition

The final destructive path is:

```text
Truly Complete
→ read-only Locate
→ reserve one actionable scope
→ wait for safety deadline
→ settings policy turn and fresh policy check
→ atomically persist safety issuance + Attempted
→ one targeted Clear
→ atomically persist result + tombstone + circuit outcome + next deadline
  + manual Worklist intent
→ arm projection watchdog
→ persist Worklist state
→ exact-revision outbox ack
```

Worklist intents are narrow:

- `downloaded`: a manual scope crosses to Truly Complete.
- `failed`: an exact transfer failure affects a manual scope.
- `cleared`: a verified flip or positive `already-clear` affects a manual scope.

Automatic scopes, policy denial, no target, Clear failure, and `uncertain` emit
no Worklist intent. Projection replay never opens the Clear gate or drives a tab.

Concurrent boot, settle, pulse, and manual Drain wakes share the coordinator's
single-flight execution lane. They may repeat Locate. They cannot overlap a
destructive send.

## Activation posture

The current Settings schema keeps `clearOnSave` off by default. Keep that safer
posture. The existing popup teaching strip is not the Worklist spec's required
one-time Clear announcement. No implementation may switch the default on until a
dedicated announcement and acknowledgement path is designed, wired, and tested.
The explicit, confirmed user toggle is the only activation path in this phase.

## Verification

- Exact combined-state codec; corrupt values block sends and remain raw.
- Persisted 2–4 second post-terminal gap survives worker restart.
- One bounded attempt array; derive the 20/60,000 ms suffix and enforce 200/session.
- Worker recycle preserves the cap. Reload/update adopt it. Browser startup resets it.
- Delayed startup reset cannot under-count or open the destructive gate early.
- Pre-send storage failure blocks; no under-counted send is possible.
- Crash after terminal reply cannot persist ledger outcome without circuit feedback.
- Crash after send recovers `attempted` as one atomic uncertain/backoff transition.
- Terminal-write rejection retries the known exact result and fail-stops sibling drives.
- Three bad outcomes trigger 15/30/60-minute backoff.
- Verified Clear resets the streak; safe no-ops are neutral.
- Two scopes on one post are issued and paced separately.
- Concurrent settle, boot, and visibility wakes produce one send.
- Policy toggle during pacing is rechecked before Attempted.
- Policy toggle cannot interleave between Attempted and the targeted send.
- Immediate partial-scope tombstone survives restart before sibling resolution.
- Clear Log contains only verified Clears and preserves 20-digit snowflakes.
- Popup distinguishes unavailable, empty, and populated log states.
- Master Clear stays default-off until its dedicated first-run announcement exists.
- Full gates plus live, non-destructive MV3 timing proof. Real account mutation
  remains limited to an explicit safe test post.
