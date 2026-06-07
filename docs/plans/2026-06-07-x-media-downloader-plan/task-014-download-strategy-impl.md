# Task 014 — Download Strategy seam + Fetched (offscreen) path

**type:** impl
**depends-on:** ["007-download-queue-impl"]

> Implements ADR-0003. *Direct* is built in task 007; this adds the seam + the
> opt-in *Fetched* strategy.

## BDD Scenario

```gherkin
Scenario: Direct strategy is the default and needs no extra permissions
  Given Download Strategy is Direct (default)
  When a MediaItem is saved
  Then chrome.downloads.download is called with the URL and no offscreen doc is created

Scenario: Switching to Fetched requests optional permissions
  Given the user enables Fetched
  When the next save runs
  Then chrome.permissions.request is invoked for offscreen + twimg CDN hosts
  And bytes are fetched in the SW and saved via an offscreen document
```

## Contract

```ts
export interface DownloadStrategy {
  readonly save: (item: MediaItem, filename: string) => Effect.Effect<number, DownloadError>
}
// DirectStrategy  — chrome.downloads.download({ url, filename })            (default)
// FetchedStrategy — fetch bytes in SW → offscreen doc → createObjectURL → download
```

## Files

- `src/core/download/strategy.ts` (interface + `DirectStrategy`)
- `src/core/download/fetched-strategy.ts`
- `src/entrypoints/offscreen/` (offscreen doc: blob → object URL → download)

## Steps

1. Define `DownloadStrategy`; `DirectStrategy` wraps `chrome.downloads.download`.
2. `FetchedStrategy`: ensure optional perms via
   `chrome.permissions.request({ permissions: ['offscreen'], origins: [pbs, video] })`;
   `fetch()` bytes in the SW; create/use an offscreen document to
   `URL.createObjectURL(blob)` then download; revoke + close offscreen when idle.
3. `DownloadQueue` selects the active strategy from `SettingsService`.

## Verification

- Unit: `DirectStrategy` via `fakeBrowser`; strategy selection from settings.
- Manual: toggle Fetched → confirm the permission prompt + a successful save via offscreen.
