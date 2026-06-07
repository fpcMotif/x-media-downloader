# Task 009 — MAIN-world tee (impl)

**type:** impl
**depends-on:** ["009-inject-tee-test"]

## Contract

```ts
// runs in world: "MAIN"; no extension APIs
export const installTee: () => void   // patches fetch + XHR, postMessage on match
export const isGraphqlMediaUrl: (url: string) => boolean
```

## Files

- `src/entrypoints/inject/index.ts` (WXT `world: "MAIN"` content script)
- `src/entrypoints/inject/tee.ts` (pure helpers)

## Steps

1. Save originals; wrap `fetch` and `XMLHttpRequest.prototype.open/send`.
2. On a GraphQL-media URL match, `response.clone().json()` → `window.postMessage`
   `{ source: "xmd", payload }` (origin-checked on the receiver side).
3. Always return the untouched original Response/response to the page. Never
   originate a request.

## Verification

- `bun test src/entrypoints/inject` — all green.
- Manual: load unpacked, browse a tweet, confirm content script logs captured JSON.
