# Task 009 — MAIN-world tee (impl)

**type:** impl
**depends-on:** ["009-inject-tee-test"]

> Follows docs/research/2026-06-07-grounding.md §(c). Declarative `world:'MAIN'`
> content script (NOT WXT `injectScript`) → no `web_accessible_resources`,
> CSP-robust, matches the validated TwitterMediaHarvest pattern.

## Contract

```ts
// src/entrypoints/inject.content.ts — runs in the page's JS realm, NO chrome.*
export default defineContentScript({
  matches: ['*://x.com/*', '*://twitter.com/*'],
  world: 'MAIN',
  runAt: 'document_start',          // MANDATORY — document_idle is too late
  main() { installTee() },
})
export const installTee: () => void
export const isGraphqlMediaUrl: (url: string) => boolean
```

## Files

- `src/entrypoints/inject.content.ts` (WXT `world:'MAIN'` content script)
- `src/entrypoints/inject/tee.ts` (pure helpers: `isGraphqlMediaUrl`, payload builder)

## Steps

1. Patch `XMLHttpRequest.prototype.open` (load-bearing — X's GraphQL media goes
   over XHR today) and, as hardening, `window.fetch`. Always return the untouched
   original response; never originate a request.
2. On a GraphQL-media URL match (HTTP 200), bridge MAIN→ISOLATED via a document
   `CustomEvent('xmd:media-response', { detail: { path, body } })`. (If
   `window.postMessage` is used instead, the ISOLATED receiver MUST guard
   `event.source === window`.)
3. The ISOLATED `content.ts` listens for `xmd:media-response`, treats the body as
   UNTRUSTED, and relays it to the SW (`browser.runtime.sendMessage`) for Schema
   validation there.

## Verification

- `bun test src/entrypoints/inject` — pure helpers green.
- Manual: load unpacked, browse a tweet, confirm the ISOLATED content script
  receives the captured JSON.
