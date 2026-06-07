# Task 012 — Wire end-to-end + smoke (impl)

**type:** impl
**depends-on:** ["010-content-overlays-impl", "011-popup-impl"]

## BDD Scenario

```gherkin
Scenario: Download a whole tweet's media end-to-end
  Given the extension is loaded and the user opens a tweet with 4 photos + 1 video
  When the user clicks "grab all"
  Then 5 files are saved with templated names and the popup queue reaches 5/5 complete

Scenario: Auth fallback stays off by default
  Given authFallbackEnabled is false (default)
  When the user triggers "grab full thread" on data not yet teed
  Then no extra GraphQL request is made and only already-available media is downloaded
```

## Files

- `src/entrypoints/background/index.ts` (wire DownloadQueue + SettingsService + Messaging)

## Steps

1. Background registers message handlers → enqueues into `DownloadQueue`,
   streams `QueueUpdate` back.
2. Implement the opt-in auth-fallback path (single replay, gated on setting).
3. `bun run build`, load unpacked, run both scenarios manually.

## Verification

- Full `bun test` green; `bun run build` clean.
- Manual smoke of both scenarios on x.com.
