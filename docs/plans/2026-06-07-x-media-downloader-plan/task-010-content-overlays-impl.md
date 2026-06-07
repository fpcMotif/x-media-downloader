# Task 010 — Content overlays (impl)

**type:** impl
**depends-on:** ["004-xadapter-impl", "008-messaging-impl", "009-inject-tee-impl"]

## BDD Scenario

```gherkin
Scenario: Hover download glyph on a media element
  Given a tweet with media is rendered and the tee has supplied its JSON
  When the user hovers a media element
  Then a download glyph appears, and clicking it sends a DownloadRequest for that item

Scenario: Grab all media in a tweet/thread
  Given a tweet/thread with multiple media
  When the user clicks the floating "grab all" pill
  Then a DownloadRequest is sent for every detected MediaItem
```

## Files

- `src/entrypoints/content/index.ts` (isolated world)
- `src/ui/overlay/*` (Preact components, Shadow DOM root)

## Steps

1. Receive teed JSON via `postMessage` (origin-checked); run `XAdapter.detectMedia`.
2. Mount Preact overlays into a Shadow DOM to avoid X style bleed; subtle hover
   glyph per media + a floating grab-all pill.
3. On click → `Messaging.send(DownloadRequest)`.

## Verification

- Component test for the overlay (renders glyph, fires handler).
- Manual: load unpacked on a real tweet; glyph + pill work; files download.
