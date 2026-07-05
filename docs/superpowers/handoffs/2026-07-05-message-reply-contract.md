# Handoff: Deepen the message-reply contract

- **Date:** 2026-07-05 · **Origin:** round-4 /improve-codebase-architecture (8 survey lenses → 21
  adversarial skeptics → survivors grilled; decisions adjudicated by the lead architect)
- **Status:** READY — not started. **Branch discipline:** implement on a fresh branch off main (or the
  current branch per the user's instruction at execution time); this handoff is self-contained.
- **Skeptic tally:** 3–0. Strength: STRONG.

## Problem

A guard-dropped message is indistinguishable from a legitimate empty reply. The `onMessage` listener in
`src/entrypoints/background.ts` returns `false` in two cases that look identical to the caller:

- Schema decode failure (`background.ts:1313-1321`).
- Sender-guard rejection via `isMessageAllowed` (`background.ts:1327-1333`), backed by
  `src/core/sender-guard.ts` (`CONTENT_SCRIPT_TAGS` set at lines 22-34, origin allowlist at 42-48, the
  `isMessageAllowed` predicate at 79-89).

When the listener returns `false` without calling `sendResponse`, Chrome resolves the sender's promise
with `reply: undefined`. `safeSend` (`src/core/messaging.ts:40-47`) only distinguishes three outcomes —
`ok` (with whatever `reply` came back, including `undefined`), `context-invalidated`, `error` — so a
guard-dropped message reports `{status: 'ok', reply: undefined}`, structurally identical to a legitimate
handler that happened to resolve with nothing.

Two shipped silent-failure incidents carry exactly this signature:

- `012254b` — `CaptureTweets` was missing from `CONTENT_SCRIPT_TAGS`, silently dropping every capture
  push from the overlay.
- `670d5a6` — Instagram/Threads origins were missing from `ALLOWED_CONTENT_SCRIPT_ORIGINS`
  (`sender-guard.ts:42-48`, whose own comment now documents this exact incident), silently dropping every
  overlay-to-background message — `DownloadRequest` included — from those tabs. Diagnosed only in a live
  browser, and only after a 3-commit debugging spiral (`682dd47` → `39ff403` → `670d5a6`).

Compounding the guard-drop ambiguity: `CONTENT_SCRIPT_TAGS` is typed `ReadonlySet<string>`
(`sender-guard.ts:22`), so adding a new content-script tag to the `Message` union does not force anyone to
add it here — the exact hole both incidents fell into is not caught by the type system today.

Three overlay call sites in `src/entrypoints/overlay.content/index.tsx` hand-cast an untyped reply instead
of pinning it to the schema type that already describes it:

- `index.tsx:287` — `(reply as SavedStatusResponse).saved`, inside `requestSavedStatus` (lines 280-289).
- `index.tsx:512-518` — an ad-hoc inline type (`{completed?, total?, skipped?, failures?}`) duplicating
  `QueueUpdate`'s fields (`schema/index.ts:222-236`) field-for-field. `failures` (`QueueUpdate`'s newest
  field, added for the download-failure-visibility fix) is exactly the kind of field this duplication
  nearly let drift out of sync.
- `index.tsx:796` — `(out.reply as {body?: string} | undefined)?.body`, inside the `RecoverTweetMediaRequest`
  round-trip (the enclosing block starts at line 780).

## Grilled design decisions

1. **Loud guard-drops → option (b), NO wire/protocol change.** Treat caller-side `reply === undefined`
   as an `'unclaimed'` classification and generalize the existing Capture-tags `console.warn`
   (`background.ts:1315-1321` for decode failure, `1327-1333` for guard rejection) to warn on every
   dropped tag, not just ones starting with `Capture`.
   **Decisive reason:** (i) MV3 semantics — a synchronous `sendResponse` call before `return false`
   would still deliver a reply, but this codebase never exercises that path and doesn't need to; (ii) all
   6 content-script-visible tags' handlers in `messageHandlers` (`background.ts` — see the table starting
   ~line 1155) reply a defined object on every code path, and the router's own `.catch` converts handler
   rejections to a defined failure shape — so `reply === undefined` at the caller **already uniquely
   means unclaimed**, no wire change needed to make that observable. Encode as a small helper in
   `core/messaging.ts` (e.g. `expectReply(out)` that adds an `'unclaimed'` classification when
   `status === 'ok' && reply === undefined`); `SendOutcome`'s existing 3-variant union
   (`messaging.ts:30-33`) is unchanged. **DO NOT** add a `Blocked` reply envelope or a 4th `SendOutcome`
   wire variant — the classification is caller-side and derived, not a new protocol member.

2. **`CONTENT_SCRIPT_TAGS` → `ReadonlySet<Message['_tag']>`.** Verified: `Message['_tag']` is already a
   used type expression in this file's own `MessageHandlers`/`handle` machinery
   (`background.ts:1148-1151`); all 6 current members of `CONTENT_SCRIPT_TAGS`
   (`DownloadRequest`, `DownloadTraceEvent`, `RecoverTweetMediaRequest`, `SweepEnqueueRequest`,
   `CaptureTweets`, `SavedStatusRequest`) are members of the `Message` union
   (`schema/index.ts:472-501`). Pure strengthening — compiles today with no other change, and closes the
   exact typing hole both incidents exploited (a tag can no longer be silently added to the union without
   the compiler forcing a decision about whether it belongs in this set).

3. **The three overlay cast sites → TYPE-PIN to schema types**, not runtime decode. Match the file's
   existing all-cast idiom. Verified via repo grep: `Schema.decodeUnknownResult` /
   `Schema.decodeUnknownSync` calls in this codebase are confined to two categories — the inbound
   trust-boundary decode at `background.ts:1314`, and storage-rehydration sites (`core/capture/store.ts:18`,
   `core/settings/index.ts:5,13`, `core/history/store.ts:17`, `core/cloud/upload-job.ts:117`,
   `core/sync/captures.ts:108`, `core/sync/outbox.ts:29`). `overlay.content/index.tsx` imports no
   `Schema` symbol at all today — introducing runtime decode here would be a new idiom for this file, not
   a fix.
   - `index.tsx:287` → pin to `SavedStatusResponse` (already imported/used as a cast target; convert to a
     type-only annotation/narrowing, no behavior change).
   - `index.tsx:512-518` → pin to `QueueUpdate` (`schema/index.ts:222-236`), deleting the duplicated
     ad-hoc inline type.
   - `index.tsx:796` → pin to `RecoverTweetMediaResponse` (see prerequisite discovery below).
   **PREREQUISITE DISCOVERY:** `RecoverTweetMediaResponse` (`schema/index.ts:407-410`) exists — it is the
   handler's own literal reply shape at `background.ts:1201`
   (`return { _tag: 'RecoverTweetMediaResponse', ...(body !== null ? { body } : {}) }`) — but it is **NOT**
   a member of the `Message` union (`schema/index.ts:472-501` lists `RecoverTweetMediaRequest` but not
   its response). It is an orphaned schema. Add it to the union first, then pin site 3 to it.

4. **New invariant documented at the seam:** "a content-script-visible handler must never legitimately
   reply `undefined`" — one comment on the `messageHandlers` router (near `background.ts:1155`, where the
   table is declared) and one on the `expectReply` helper in `core/messaging.ts`, cross-referencing each
   other.

## Interface sketch

Verified against the real types in the tree (`src/core/messaging.ts:30-47`,
`src/core/schema/index.ts:407-410,472-501`, `src/core/sender-guard.ts:22-34`).

```ts
// src/core/sender-guard.ts — strengthen the element type only, no value change:
export const CONTENT_SCRIPT_TAGS: ReadonlySet<Message['_tag']> = new Set([
  'DownloadRequest',
  'DownloadTraceEvent',
  'RecoverTweetMediaRequest',
  'SweepEnqueueRequest',
  'CaptureTweets',
  'SavedStatusRequest',
])
// requires importing `Message` from '../core/schema' (or wherever this file's
// existing relative import root resolves it — check current imports in the file
// before adding; sender-guard.ts currently imports nothing schema-related).

// src/core/schema/index.ts — add the orphaned response to the union (decision 3):
export const Message = Schema.Union([
  // ...existing members (schema/index.ts:472-501)...
  RecoverTweetMediaRequest,
  RecoverTweetMediaResponse, // NEW — was defined (407-410) but never unioned
  // ...
])

// src/core/messaging.ts — additive classification, SendOutcome union UNCHANGED:
export type ReplyExpectation<R> =
  | { readonly status: 'ok'; readonly reply: R }
  | { readonly status: 'unclaimed' } // reply === undefined: guard-dropped or decode-rejected
  | { readonly status: 'context-invalidated' }
  | { readonly status: 'error'; readonly error: unknown }

/** Reclassifies a safeSend outcome: an 'ok' status whose reply is undefined means
 *  the background never claimed the message (sender-guard rejection or schema
 *  decode failure) — every content-script-visible handler in messageHandlers
 *  replies a defined object on every path, so undefined already uniquely means
 *  unclaimed. Does not change safeSend's own SendOutcome union. */
export const expectReply = <R>(out: SendOutcome<R>): ReplyExpectation<R> =>
  out.status === 'ok' && out.reply === undefined ? { status: 'unclaimed' } : out
```

Exact naming (`ReplyExpectation`, `expectReply`) is a suggestion, not a contract — keep whatever reads
best against the file's existing naming (`SendOutcome`, `safeSend`), but preserve the shape: a pure,
additive, caller-side reclassification function with no change to `safeSend` or `SendOutcome`.

## Out of scope — DO NOT

- Build a `messageClient` module — refuted in an earlier architecture-review round (see
  `serial-queue-is-one-seam-not-two` precedent for why speculative wrapper modules here get rejected on
  deletion-test grounds).
- Change `SendOutcome`'s wire behavior or add a 4th variant to it (decision 1).
- Add runtime `Schema.decode` at the three overlay reply sites (decision 3) — that would introduce a new
  idiom into a file that has none today; type-pin only.
- Touch `sender-guard.ts`'s `ALLOWED_CONTENT_SCRIPT_ORIGINS` list (lines 42-48) — that is the
  platform-identity handoff's territory. This handoff only types `CONTENT_SCRIPT_TAGS`.

## Plan with verifiable goals

1. Add `RecoverTweetMediaResponse` to the `Message` union in `src/core/schema/index.ts` (~line 501).
   → verify: `bun run check`
2. Type `CONTENT_SCRIPT_TAGS: ReadonlySet<Message['_tag']>` in `src/core/sender-guard.ts:22`, importing
   `Message` from its schema module.
   → verify: `bun run check`
3. Pin the three overlay cast sites (`overlay.content/index.tsx:287`, `:512-518`, `:796`) to
   `SavedStatusResponse`, `QueueUpdate`, and `RecoverTweetMediaResponse` respectively, deleting the
   duplicated ad-hoc inline type at `:512-518`.
   → verify: `bun run check`
4. Generalize the guard-drop/decode-fail warnings in `background.ts` (currently gated on
   `rawTag.startsWith('Capture')` at ~1315-1321 and `msg._tag.startsWith('Capture')` at ~1327-1333) to
   fire for every dropped tag; add the `expectReply` helper (or equivalent) to `core/messaging.ts`; add
   the two seam-invariant comments (decision 4); add `messaging.test.ts` cases asserting the
   `'unclaimed'` classification for `{status: 'ok', reply: undefined}` and pass-through for the other
   three outcome shapes.
   → verify: `bun run check` && `bun run test:coverage` (must stay 100% over `src/core` + `src/lib`)
5. Final gate sweep.
   → verify: `bun run check`, `bun run test:coverage`, `bun run build`

## Files

- `src/core/schema/index.ts` — add `RecoverTweetMediaResponse` to the `Message` union.
- `src/core/sender-guard.ts` — type `CONTENT_SCRIPT_TAGS` as `ReadonlySet<Message['_tag']>`.
- `src/core/messaging.ts` — add the `expectReply` (or equivalently named) helper; doc comment for the
  seam invariant.
- `src/entrypoints/background.ts` — generalize the two guard-drop/decode-fail `console.warn` calls
  (~1315-1321, ~1327-1333); doc comment on `messageHandlers` for the seam invariant.
- `src/entrypoints/overlay.content/index.tsx` — pin the three cast sites (287, 512-518, 796) to schema
  types; delete the duplicated inline type.
- `src/core/messaging.test.ts` — add `'unclaimed'`-classification test cases.

## Test plan

- `src/core/messaging.test.ts` mirrors its existing idiom exactly: plain `describe`/`it` blocks per
  function (`describe('isContextInvalidatedError', …)`, `describe('safeSend', …)` at lines 4 and 43).
  Add a third `describe('expectReply', …)` (or the chosen name) block alongside them, same file, same
  style — table-free, explicit `expect(...).toEqual(...)` per case, one case per `SendOutcome` variant
  plus the new `'ok'`-with-`undefined`-reply case.
- `src/core/sender-guard.test.ts` (167 lines) is unchanged behaviorally — its `CONTENT_SCRIPT_TAGS`
  content-equality test at lines 8-19 (`expect([...CONTENT_SCRIPT_TAGS].toSorted()).toEqual([...])`)
  keeps passing unmodified since the type change doesn't alter the value.
- No new overlay-side tests are prescribed by the grilled decisions for the three cast-site pins — they
  are compile-time-only strengthenings (a bad pin fails `tsgo --noEmit` inside `bun run check`, not a
  runtime test). Do not invent new overlay tests for this step; if `overlay.content/index.tsx` already
  has a test file, confirm it still passes but do not expand its scope for this handoff.
- Coverage stays 100% over `src/core` + `src/lib` per the repo's existing gate; `src/entrypoints` (the
  UI/background layer) is excluded by design, so `background.ts` and `overlay.content/index.tsx` changes
  are not gated by the coverage number, only by `bun run check`.

## Coordination

`src/core/sender-guard.ts` is also touched by the platform-identity handoff (the
`ALLOWED_CONTENT_SCRIPT_ORIGINS` set, lines 42-48). Land the platform-identity handoff first: both edits
land in the same file but touch semantically independent, non-overlapping regions (the origins `Set` vs.
the tags `Set`'s type annotation), so the ordering is about avoiding a merge headache, not a real
dependency — either handoff's diff should apply cleanly regardless of the other's presence, but doing
platform-identity first avoids a two-way rebase on the same file.
