# Task 005 — Filename engine (impl)

**type:** impl
**depends-on:** ["005-filename-test"]

## Contract

```ts
export const renderFilename: (template: string, item: MediaItem, date?: string) => string
```

## Files

- `src/core/download/filename.ts`

## Steps

1. Pure token replacement for `{handle} {tweetId} {index} {ext} {type} {date}`.
2. Sanitize each segment: strip `..`, illegal chars `:*?"<>|`, collapse slashes;
   keep intentional `/` from the template as directory separators only.
3. Unknown tokens → empty string.

## Verification

- `bun test src/core/download/filename` — all green.
