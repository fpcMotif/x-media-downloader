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
2. Sanitize each segment: strip illegal chars `:*?"<>|` + control chars; keep
   intentional `/` from the template as directory separators only.
3. Unknown tokens → empty string.
4. **Hard post-render guard (`chrome.downloads.download` throws otherwise):** emit
   a RELATIVE path only — strip leading `/`, reject/strip every `..` segment,
   never emit an absolute or empty path. Forward-slash subdirs are allowed.

## Verification

- `bun test src/core/download/filename` — all green.
