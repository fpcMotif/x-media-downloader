# 001 — Block forged media URLs

- **Workflow**: improve-react
- **Status**: TODO
- **Commit**: cf787c6
- **Severity**: HIGH
- **Category**: Security
- **Rule**: Beyond the scan
- **Estimated scope**: 7 files, about 145 lines

## Problem

Page scripts can emit the same DOM event as the MAIN-world response tee:

```ts
// src/entrypoints/inject.content.ts:20 — current
const emit = (path: string, body: string): void => {
  document.dispatchEvent(new CustomEvent('xmd:media-response', { detail: { path, body } }))
}
```

The isolated overlay trusts every matching event and stores parsed items:

```ts
// src/entrypoints/overlay.content/index.tsx:1669 — current
document.addEventListener('xmd:media-response', (event) => {
  const detail = (event as CustomEvent<{ path: string; body: string }>).detail
  // ...
  if (store.addDetected(adapter.detectFromResponse(detail.path, json)).length > 0) rerender()
})
```

Meta detection copies an arbitrary string into `MediaItem.url` at
`src/core/adapters/meta-shared/detect.ts:71`. `handleDownload` passes items to
admission and size probes at `src/entrypoints/background.ts:853` before any URL
allow-list check. Direct download later uses the URL unchanged:

```ts
// src/core/download/strategy.ts:61 — current
downloads.download({ url: req.url, filename: req.filename, conflictAction: 'uniquify' })
```

An untrusted page can therefore feed a hostile URL into privileged extension
work. The same missing check affects X response parsing and refreshed retry URLs.

## Target

Reuse the existing CDN guard. Add this beside `assertAllowedMediaUrls`:

```ts
// src/core/sync/url-guard.ts — target
import type { MediaItem } from '../schema'

export interface RejectedMediaItemUrl {
  readonly itemId: string
  readonly reason: string
}

export function partitionAllowedMediaItems(
  items: ReadonlyArray<MediaItem>,
): {
  readonly allowed: MediaItem[]
  readonly rejected: RejectedMediaItemUrl[]
} {
  const allowed: MediaItem[] = []
  const rejected: RejectedMediaItemUrl[] = []

  for (const item of items) {
    try {
      assertAllowedMediaUrls(item.url, item.previewUrl)
      allowed.push(item)
    } catch (cause) {
      if (!(cause instanceof UnsafeUrlError)) throw cause
      rejected.push({ itemId: item.id, reason: cause.reason })
    }
  }

  return { allowed, rejected }
}
```

At event ingestion, store only allowed items:

```ts
// src/entrypoints/overlay.content/index.tsx — target inside the current listener
const checked = partitionAllowedMediaItems(adapter.detectFromResponse(detail.path, json))
if (checked.rejected.length > 0) {
  console.warn(`[XMD] dropped ${checked.rejected.length} media item(s) with unsafe URLs`)
}
if (store.addDetected(checked.allowed).length > 0) rerender()
```

At the start of `handleDownload`, before `admissionGate.admit`, partition again:

```ts
// src/entrypoints/background.ts — target
const checked = partitionAllowedMediaItems(items)
const urlFailures = checked.rejected.map(({ itemId, reason }) => ({
  itemId,
  reason: `unsafe media URL: ${reason}`,
}))
const admission = yield* Effect.promise(() => admissionGate.admit(checked.allowed))
```

Mixed batches keep valid items. Initialize the existing later failure list with
the URL failures:

```ts
// src/entrypoints/background.ts:1017 — target
const failures: { itemId: string; reason: string }[] = [...urlFailures]
```

When no request remains, return `total: urlFailures.length` and include failures.
In the final response, use `total: res.total + urlFailures.length`. This keeps
`sendTracked` false if any URL was rejected.

Guard the refreshed retry URL before persistence or download:

```ts
// src/entrypoints/background.ts:569 — target, directly after resolveRetryUrl(meta)
try {
  assertAllowedMediaUrl(url)
} catch (cause) {
  traceBackground('interrupt-retry-blocked', {
    itemId: id,
    detail: cause instanceof UnsafeUrlError ? cause.reason : 'unsafe media URL',
  })
  await failBrowserDownload(id, -1, Date.now())
  return
}
```

## Repo conventions to follow

- Reuse `src/core/sync/url-guard.ts:71-97`; it derives hosts from the adapter registry.
- Follow tagged-error tests in `src/core/sync/url-guard.test.ts:10-115`.
- Follow the defined-failure reply path at `src/entrypoints/background.ts:1416-1427`.
- Keep parsing pure. `resolveTweetMedia` and Meta walkers may parse hostile data;
  the trust boundaries reject it.

## Steps

1. Add `partitionAllowedMediaItems` and its type-only import.
2. Filter response-derived items before `store.addDetected`.
3. Filter every initial download batch before admission, probes, persistence,
   sidecar planning, sync, or a strategy.
4. Merge URL failures into both `QueueUpdate` return paths.
5. Guard `fireInterruptRetry` before changing `requestMetaById`.
6. Extend `src/core/sync/url-guard.test.ts` for valid X, valid Meta, hostile host,
   hostile preview, mixed-order, and unexpected-error behavior.
7. Add composition regressions to the existing Meta detect and X resolver tests.
   The Meta detect fixtures currently use `https://cdn.example/...`, which is
   intentionally not allowed. For guard-composition assertions only, clone the
   parsed item or fixture with an allow-listed URL such as
   `https://scontent.cdninstagram.com/v/example.jpg`. Do not widen the guard to
   make `cdn.example` pass.
8. Update the `QueueUpdate.failures` schema comment at
   `src/core/schema/index.ts:231-236` to cover URL-validation failures as well as
   strategy start failures. Do not change the schema shape.
9. Re-read the diff. Remove unrelated churn.

## Boundaries

- Do NOT add a DOM nonce. Page code can observe DOM secrets.
- Do NOT widen CDN hosts, permissions, or schemes.
- Do NOT refine the shared `MediaItem` schema or change parsers.
- Do NOT log a rejected full URL.
- Preserve generated `data:` sidecars.
- Preserve valid items in a mixed batch.
- Add no dependency.
- STOP if code differs from commit `cf787c6`; reconcile first.

## Verification

- **Mechanical**:
  - `bun run test -- src/core/sync/url-guard.test.ts src/core/adapters/meta-shared/detect.test.ts src/core/resolver/resolver.test.ts`
  - `bun run typecheck`
  - `bun run lint`
  - `bun run build`
  - `npx --yes react-doctor@latest . --scope changed` adds no issue and lowers no score.
- **Behavior check**: In a test build, dispatch a forged response fixture whose
  media URL is `https://attacker.example/payload.exe`. Confirm detection count
  does not increase, no HEAD/fetch/download reaches that host, and the warning
  contains a count but no URL. Then download one real item on X, Instagram, and
  Threads.
- **Done when**: all ingress and retry paths fail closed, valid CDN items still
  download, mixed-batch failures are visible, and all checks pass.
