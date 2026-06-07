# Task 003 — MediaResolver (test)

**type:** test
**depends-on:** ["002-schema-impl"]

## BDD Scenario

```gherkin
Scenario: Upgrade photo URL to original quality
  Given a pbs.twimg.com photo URL with "&name=small"
  When the resolver normalizes it
  Then the URL uses "&name=orig" and ext is derived from the format param

Scenario: Select the highest-bitrate video variant
  Given a video_info.variants array with bitrates [256000, 832000, 2176000] and one m3u8 (no bitrate)
  When the resolver selects a variant
  Then it returns the 2176000-bitrate mp4 variant

Scenario: Dedupe repeated media
  Given a tweet whose JSON references the same media id twice
  When the resolver produces MediaItems
  Then the same id appears exactly once
```

## Files

- `src/core/resolver/resolver.test.ts`
- `src/test/fixtures/tweet-photos.json`, `tweet-video.json` (gallery-dl-shaped)

## Steps

1. Add fixtures mirroring X GraphQL `extended_entities.media[]` shapes.
2. Write failing tests for photo upgrade (+fallback chain order), variant
   selection (max bitrate, ignore non-mp4), and dedupe.

## Verification

- `bun test src/core/resolver` — runs and **fails** (red).
