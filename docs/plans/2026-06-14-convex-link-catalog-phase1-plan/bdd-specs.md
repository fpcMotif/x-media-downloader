# BDD Specs — Phase 1 MVP (Convex Link Catalog)

Source of truth for the Phase-1 task decomposition. Scope is **link catalog only**
(spec §9 Phase 1): no bring-your-own-cloud, no provider matrix, no presign/video path.
"Safe" in Phase 1 means *the original link + metadata is durably recorded in Convex*,
not that bytes are mirrored to a cloud.

Derived from: `docs/superpowers/specs/2026-06-14-convex-cloud-backup-design.md` (ADR-0011/0012),
validated against the Phase-0 prototype `study/cloud-sync-prototype/machine.ts`.

---

## Feature: Cloud-sync settings (off by default)

```gherkin
Scenario: Cloud sync is off on a fresh install
  Given a user who has never opened settings
  When the extension loads its settings
  Then cloudSyncEnabled is false
  And syncTrigger defaults to "onDownload"
  And cloudConvexUrl is empty (no vendor default)

Scenario: Corrupt settings recover to safe defaults
  Given a settings blob with an unknown/invalid syncTrigger value
  When settings are decoded
  Then decoding succeeds with cloudSyncEnabled false and syncTrigger "onDownload"
  And no exception escapes to the caller

Scenario: User selects a sync trigger
  Given cloud sync is enabled
  When the user sets syncTrigger to "both"
  Then the stored setting is "both"
  And the value is one of onDownload | onDemand | both
```

## Feature: Convex catalog backend (catalogItems + syncItems)

```gherkin
Scenario: An authenticated user syncs a grabbed item's link
  Given an authenticated user
  And a MediaItem with id "m-1", tweetId "1001", handle "alice", type "photo", url "https://pbs.twimg.com/...orig"
  When syncItems is called with that item
  Then a catalogItems row exists for (userId, "m-1")
  And it stores the original url, previewUrl, tweetId, handle, type, ext, capturedAt

Scenario: Re-syncing the same item is idempotent
  Given a catalogItems row already exists for (userId, "m-1")
  When syncItems is called again with the same item
  Then no duplicate row is created
  And the call succeeds (no error)

Scenario: Unauthenticated sync is rejected
  Given a caller with no authenticated identity
  When syncItems is called
  Then the call is rejected
  And no catalogItems row is written

Scenario: Catalog is scoped per user
  Given user A has a catalogItems row for "m-1"
  When user B lists their catalog
  Then user B does not see user A's "m-1" row
```

## Feature: Sync core — pure state (lifted from the Phase-0 prototype)

```gherkin
Scenario: The master gate blocks capture and never touches the download
  Given cloudSyncEnabled is false
  When a download-complete capture is attempted for an item
  Then the item is not enqueued
  And the result reports the download path was untouched

Scenario: A completed download auto-captures only when the trigger opts in
  Given cloudSyncEnabled is true
  And syncTrigger is "onDemand"
  When a download-complete capture is attempted
  Then the item is not enqueued
  When syncTrigger is "onDownload" and the capture is retried
  Then the item is enqueued

Scenario: The on-demand backup button always captures while sync is on
  Given cloudSyncEnabled is true
  And syncTrigger is "onDownload"
  When an on-demand capture is attempted for an item
  Then the item is enqueued

Scenario: Per-item status rolls up to a 3-state value
  Given an item that has been captured but not yet confirmed in Convex
  Then its status is "pending"
  When syncItems confirms the catalog write
  Then its status is "safe"
  When the sync write fails terminally
  Then its status is "failed"

Scenario: Re-capturing an already-queued item is deduped
  Given an item already sits in the capture set
  When the same item is captured again
  Then the capture set still contains exactly one entry for it
```

## Feature: Durable local sync-queue

```gherkin
Scenario: A capture is buffered durably
  Given an item is captured
  Then it is written to the durable local:sync-queue
  And the queue value persists in extension storage

Scenario: The queue survives a service-worker recycle
  Given one item sits in the local:sync-queue
  When the service worker is recycled (in-memory state lost)
  Then re-reading the queue from storage still returns that item

Scenario: Flush drains the queue into syncItems
  Given two items sit in the local:sync-queue
  When flush runs
  Then syncItems is called for both items
  And the queue is emptied only for items that synced successfully

Scenario: A duplicate enqueue is deduped in the queue
  Given an item "m-1" is already in the queue
  When "m-1" is enqueued again
  Then the queue contains a single entry for "m-1"
```

## Feature: Background integration (the sync seam)

```gherkin
Scenario: A completed download is captured and flushed under onDownload
  Given cloudSyncEnabled is true and syncTrigger is "onDownload"
  And the user is signed in
  When a browser download transitions to complete
  Then the item is enqueued to the local:sync-queue
  And a flush runs that calls syncItems for it

Scenario: With sync off, the download path is never altered
  Given cloudSyncEnabled is false
  When a browser download transitions to complete
  Then no capture is attempted
  And the existing download/metrics behavior is unchanged

Scenario: Signed-out with sync on does not call the backend
  Given cloudSyncEnabled is true but the user is signed out
  When a browser download transitions to complete
  Then no syncItems call is made
```

## Feature: Popup — consent gate and honest status

```gherkin
Scenario: First run shows the disclosure gate with sync off
  Given a fresh install
  When the popup opens
  Then cloud sync is shown as off
  And a disclosure explains what leaves the device before it can be enabled

Scenario: Enabling sync requires passing the consent gate
  Given the popup is open with sync off
  When the user toggles cloud sync on
  Then the consent disclosure is presented
  And cloudSyncEnabled becomes true only after acknowledgement

Scenario: The status line shows honest 3-state counts
  Given items exist in the catalog with mixed states
  When the popup renders the status line
  Then it shows counts for safe, syncing (pending), and failed
  And "safe" reflects a confirmed Convex catalog write, not merely a started one

Scenario: On-demand backup from the popup
  Given the popup is open and sync is enabled
  When the user triggers "Back up now"
  Then the relevant item(s) are captured via the on-demand path
```

## Feature: Documentation & reconciliation (acceptance, not test-runnable)

```gherkin
Scenario: PRODUCT.md is reframed local-first
  Given PRODUCT.md currently promises "local-only"
  When the reframe lands
  Then it states "local-first; optional, user-controlled cloud sync, off by default"
  And it references ADR-0011

Scenario: ADR-0013 exists
  Given the spec cites ADR-0013 for the byte path and phasing
  When docs/adr is checked
  Then 0013-server-side-cloud-destinations.md exists and records the decision

Scenario: The two Phase-1 catalog designs are reconciled
  Given branch claude/elegant-franklin-g4ofol shipped sync_events/media_state + an Outbox
  And this plan introduces catalogItems/syncItems for the same seam
  When the reconciliation spike completes
  Then a single seam is chosen and the decision is recorded in an ADR or the spec
  And the plan's Convex tasks are updated to match the chosen seam
```
