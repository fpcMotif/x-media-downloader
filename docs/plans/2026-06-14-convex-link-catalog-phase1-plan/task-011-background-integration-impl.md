# Task 011 — Background sync seam (impl / Green)

- **type:** impl
- **depends-on:** ["010"]
- **files:** `src/core/sync/seam.ts` (new), `src/entrypoints/background.ts` (wire), `src/core/schema/index.ts` (optional: a `PopupOpened`/flush message)

## Objective

Implement the injectable seam and wire it into `background.ts` at the `downloads.onChanged` complete
branch and a popup-open flush trigger. The seam is **fire-and-forget and fail-closed**: any error is
swallowed so the existing download/metrics flow ([background.ts](../../../src/entrypoints/background.ts))
is never blocked or changed.

## Contracts (signatures only — no bodies)

```ts
// src/core/sync/seam.ts
export interface SyncSeam {
  onDownloadComplete(item: MediaItem): Promise<void>  // gate → enqueue → flush
  onPopupOpen(): Promise<void>                         // flush only
}
export function makeSyncSeam(deps: {
  getSettings: () => Promise<{ cloudSyncEnabled: boolean; syncTrigger: SyncTrigger }>
  isSignedIn: () => Promise<boolean>
  getQueue: () => SyncQueue
  getClient: () => SyncClient | null
}): SyncSeam
```

## BDD Scenario

```gherkin
Scenario: A completed download is captured and flushed under onDownload
  Given cloudSyncEnabled is true, syncTrigger "onDownload", user signed in
  When a download transitions to complete for an item
  Then the item is enqueued and syncItems is called

Scenario: With sync off, the download path is never altered
  Given cloudSyncEnabled is false
  When a download transitions to complete
  Then no capture is attempted and existing metrics behavior is unchanged
```

## Steps

1. Implement `makeSyncSeam`: `onDownloadComplete` applies `decideCapture`; if enqueue and signed-in,
   enqueue then flush; wrap in try/catch (fail-closed).
2. In `background.ts`, resolve the completed `MediaItem` for a finished `downloadId` and call
   `seam.onDownloadComplete(item)` **after** the existing metrics reconciliation, without awaiting it
   in the critical path.
3. Add a popup-open flush trigger (message or direct call).

## Verification

- `bun run test src/core/sync` → **GREEN**.
- `bun run test` (full) stays green — existing background/metrics tests unaffected.
- Manual: with sync off, a normal download behaves exactly as before.
