# Popup action lifecycle design

> **Superseded for direct Release (2026-07-26).** The popup no longer sends
> page/list Release commands. Only download/sweep actions remain; Clear runs
> through the durable download-completion coordinator. Keep this file as design
> history.

**Date:** 2026-07-18

**Status:** Accepted for implementation

## Problem

Each popup action owns a private `busy` flag and casts an unknown tab reply to
its hoped-for shape. This creates three false states:

- Two release actions can run together and click the same live controls.
- An absent or malformed content-script reply becomes a valid zero-work result.
- That false result completes first-run teaching.

Archive erase has the same truth gap on the background channel. It clears local
UI and reports success even when the worker rejects or never claims the request.

## Chosen module

One framework-free `PopupActions` module owns all tab action policy.

```ts
interface PopupActions {
  run(intent: PopupIntent): Promise<ActionOutcome>
  inspect(): PopupActionView
  subscribe(listener: () => void): () => void
  dispose(): void
}

interface PopupActionView {
  readonly active: ActionId | null
  readonly notices: Readonly<Record<'download' | 'release', Notice | null>>
}
```

It receives small ports for active-tab lookup, tab messaging, clock, context
classification, and first-run completion. Preact only subscribes and renders.

Every run fresh-queries the active tab, reclassifies its URL, sends one typed
request, and exactly decodes the tagged reply. `undefined`, a wrong tag, missing
fields, extra fields, unsafe/negative counts, and impossible success/reason
combinations are invalid responses. A page or list Release reply may report only
`{ cleared: 0, reason: 'not-x' | 'not-list-page' }`; either becomes the
inapplicable list-page copy. Release UI remains list-only, so this is a stale-tab
race guard, not another available state.

Release actions are available only on Likes and Bookmarks list pages. Both
page-scoped and whole-list release requests are meaningless elsewhere.

## Lease and notice rules

1. One global action lease exists. No download or destructive release action
   overlaps another popup action.
2. The lease is acquired synchronously before tab lookup and released in
   `finally`.
3. While leased, every action trigger is disabled. A stale invocation performs
   no transport.
4. Starting an action clears only its download or release notice.
5. Valid result notices expire after six seconds.
6. No-tab, unreachable, stale-context, and invalid-response notices persist
   until the next action in that cluster.
7. Late results after `dispose()` change no view or first-run state.
8. First-run completes once, only after an exactly decoded Stage completion.
   Valid zero work still counts.

The global lease is deliberate. Download and Release both target the same live
tab; manual Release can remove the DOM that a simultaneous download or sweep is
reading. The popup gains nothing from parallel commands.

## Stage start acknowledgement

`DrainPageRequest` keeps its content-script channel open until `sendTracked`
gets an exact, request-bound `QueueUpdate`. `planned` contains fresh artifacts;
`started`, `deferred`, and `failures` exactly partition it. Requested main media
exactly partition into planned, success-equivalent `duplicates`, or `skipped`.
Malformed or unclaimed replies and transport failure return
`{ _tag: 'DrainPageResponse', ok: false, reason: 'background' }`. A dead
extension context returns the same shape with `reason: 'context'`.

A valid reply completes Stage only when `skipped` and `failures` are empty.
Deferred artifacts remain durably accepted. Duplicate media is success-equivalent.

Admission is atomic per media group. One group is the main media artifact plus
its optional metadata sidecar. If either artifact is already owned, the
Registry persists and starts neither artifact, and `duplicates` reports the
main request ID. A sidecar can never outlive a rejected main artifact.

The popup accepts only either `{ _tag: 'DrainPageResponse', ok: true, count }`
or the exact false shape above. Context uses stale-tab copy. Background start
failure uses persistent `DOWNLOAD_START_FAILED` copy. Only the true shape
completes first-run teaching.

## Archive erase

A small `requestCaptureErase` client owns the background wire check:

```ts
type CaptureEraseOutcome = { readonly ok: true; readonly cleared: number } | { readonly ok: false }
```

It contains synchronous throws, rejected sends, unclaimed replies, and malformed
`{ cleared }` values. `CaptureQuickActions` resets its summary and shows erased
copy only for `ok: true`; failure preserves the archive view and shows an error.
The acknowledged `cleared` count, not a stale summary count, drives success copy.

## Rejected designs

- **Four `usePageAction` hooks:** duplicate transport policy and cannot arbitrate
  cross-action work.
- **One lease per action id:** still lets page/list release race each other.
- **One lease per notice cluster:** blocks the reproduced release race but still
  lets manual Release invalidate a concurrent download scan.
- **Cast then default fields to zero:** converts protocol drift into false success.
- **Trust a fulfilled Promise:** Chrome may fulfill an unclaimed message with
  `undefined`.
- **Put parsing in JSX:** makes exact wire semantics hard to test and reuse.

## Verification

- Hold each action at active-tab lookup. Every second action returns busy and
  sends nothing, including cross-cluster pairs.
- Accept every exact tagged reply and reject wrong, missing, extra, fractional,
  negative, and impossible shapes.
- Prove stale-tab Release replies use only zero-work `not-x` or `not-list-page`
  reasons and render the inapplicable list-page copy.
- Treat `undefined`, synchronous throw, and rejection as failures.
- Prove invalid or unclaimed Stage replies never complete first-run.
- Prove a valid zero-work Stage reply completes it once.
- Delay the start acknowledgement; prove the content-script response waits.
- Reject every malformed QueueUpdate and map context versus background failure.
- Prove result expiry, persistent errors, later notice ownership, and disposal.
- Reject archive erase transport and malformed replies; UI data remains.
- Acknowledge archive erase; UI clears and copy uses the returned count.
- Run focused tests, Effect diagnostics, full check, and production build.
