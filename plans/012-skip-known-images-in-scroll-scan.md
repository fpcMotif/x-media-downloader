# Plan 012: Skip already-resolved images in the X scroll scan

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 7456911 -- src/core/adapters/x/index.ts src/core/adapters/types.ts src/core/adapters/detection-store.ts src/entrypoints/overlay.content/index.tsx src/core/adapters/x/xadapter.test.ts src/core/adapters/detection-store.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `7456911`, 2026-11-16. Excerpts were read from a working tree with uncommitted changes on top of this commit. Compare every excerpt with the live file before editing.

## Why this matters

On x.com the content script runs a "rendered media scan" once per animation
frame while the user scrolls. Each scan walks every `<img>` in the document and
fully re-resolves it: one `new URL(...)` parse, several `closest()` calls, and
a `querySelectorAll` over the enclosing tweet article. Almost every image was
already resolved on the previous frame, so the work is repeated for nothing on
the host page's main thread during scrolling. After this plan the scroll scan
resolves an image only when it is new, its `src` changed, its tweet article
gained or changed an image, or the store no longer holds its item. A second,
smaller cost goes too: the recovery scan stops copying the whole key index into
a new `Set` on every call.

## Current state

Files and roles:

- `src/core/adapters/x/index.ts` — X DOM resolvers. `detectRenderedImageElements`
  (lines 196–209) is the scan. `resolveImageElement` (167–194) resolves one image.
  `photoIndexInArticle` (141–154) is the per-article walk it triggers.
  `videoTweetsNeedingRecovery` (273–296) is the recovery scan.
- `src/core/adapters/types.ts` — the `PlatformAdapter` interface.
  `detectRenderedMedia` is declared at line 60, `findMediaNeedingRecovery` at 82.
- `src/core/adapters/x/adapter.ts` — wires `detectRenderedMedia: detectRenderedImageElements`
  (line 41). Instagram and Threads adapters use `detectRenderedMedia: () => []`.
- `src/core/adapters/detection-store.ts` — the Detected Media Set. `needsRecovery`
  (lines 307–308) copies the key index.
- `src/entrypoints/overlay.content/index.tsx` — the content script. `scanRenderedMedia`
  (874–878) and the scroll listener (2102–2111).

The scan, as it is today (`src/core/adapters/x/index.ts:196-209`):

```ts
/** Resolve rendered X photo images already present in a timeline/list DOM. */
export function detectRenderedImageElements(root: ParentNode, pathname = ''): MediaItem[] {
  const out: MediaItem[] = []
  const seen = new Set<string>()
  for (const img of root.querySelectorAll<HTMLImageElement>('img')) {
    const item = resolveImageElement(img, pathname)
    /* v8 ignore next -- item.url is always a grabbable /media/ photo with a valid key, so the `?? item.id` arm is dead */
    const key = item ? (mediaKeyFromUrl(item.url) ?? item.id) : null
    if (!item || !key || seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}
```

The start of `resolveImageElement` (`src/core/adapters/x/index.ts:167-175`):

```ts
export function resolveImageElement(img: HTMLImageElement, pathname = ''): MediaItem | null {
  const src = img.currentSrc || img.src
  if (!isGrabbablePhotoUrl(src)) return null
  const key = mediaKeyFromUrl(src)
  if (!key) return null

  const article = img.closest(TWEET_ARTICLE_SEL)
  const ctx = resolveTweetContext(img, article, pathname)
  const index = ctx?.index ?? (article ? photoIndexInArticle(article, img, ctx?.tweetId) : 0)
```

The returned item uses the media key as its id (`id: key`, line 185). The
photo index depends on the other images in the same article
(`src/core/adapters/x/index.ts:146-150`):

```ts
  const photos = Array.from(article.querySelectorAll('img')).filter((el) => {
    if (!isGrabbablePhotoUrl(el.currentSrc || el.src)) return false
    const elCtx = linkContext(el.closest(STATUS_LINK_SEL))
    return (elCtx?.tweetId ?? tweetId) === tweetId
  })
```

The adapter interface (`src/core/adapters/types.ts:58-60`):

```ts
  /** DOM layer: media already rendered in a timeline/list, for the initial
   *  paint before any network capture lands. */
  detectRenderedMedia(root: ParentNode, pathname: string): MediaItem[]
```

The per-frame caller (`src/entrypoints/overlay.content/index.tsx:874-878`):

```ts
    const scanRenderedMedia = (): void => {
      if (store.addDetected(adapter.detectRenderedMedia(document, location.pathname)).length > 0) {
        rerender()
      }
    }
```

It is queued by every scroll event (`src/entrypoints/overlay.content/index.tsx:2102-2111`):

```ts
    ctx.addEventListener(
      document,
      'scroll',
      () => {
        queueRenderedMediaScan()
        scheduleScrollVideoRecovery()
        queueScrollHitTest()
      },
      { capture: true, passive: true },
    )
```

Other callers of `adapter.detectRenderedMedia` exist and must keep doing a full
scan: `src/entrypoints/overlay.content/index.tsx:1505` (Rescan),
`src/entrypoints/overlay.content/handlers.ts:418` and `:1172`, and
`src/entrypoints/overlay.content/post-grab.ts:198`.

The store is created at `src/entrypoints/overlay.content/index.tsx:717`
(`const store = makeDetectionStore({`). The store is emptied by `store.clear()`
on route change (`index.tsx:2204`), on Rescan (`index.tsx:1504`), and in
`handlers.ts:1156`. `store.get(id)` returns `undefined` for an id it does not hold.

The key-index copy (`src/core/adapters/detection-store.ts:307-308`):

```ts
    needsRecovery: (root) =>
      deps.findMediaNeedingRecovery?.(root, new Set(byKey.keys()), attempted) ?? [],
```

`byKey` is a `Map<string, MediaItem>` (line 176). The recovery scan only calls
`.has` on that argument (`src/core/adapters/x/index.ts:289`):

```ts
    if (!key || detectedKeys.has(key)) continue
```

The `detectedKeys: ReadonlySet<string>` parameter type appears in three places:
`src/core/adapters/x/index.ts:275`, `src/core/adapters/types.ts:84`, and
`src/core/adapters/detection-store.ts:171`.

Design constraint, quoted from `docs/adr/0016-media-key-identity.md`: "The
grain is **pure media key**, not a `${tweetId}:${mediaKey}` composite." A
`MediaItem.id` for an X photo is its media key. This plan does not change ids.

Repo conventions that apply (from `AGENTS.md`):

- No `oxlint-disable`, `eslint-disable`, `@ts-ignore`, or `@ts-expect-error`.
- Every `as` needs an uppercase `SAFETY:` comment. Prefer narrowing so you need no `as`.
- `unknown` is banned in parameters, returns, and type aliases.
- Named constants, not magic numbers. `for...of` over `.forEach()`.
- Tests are vitest. Assertions live inside `it()`.

Comment rule: do not add, edit, or delete code comments, except a comment that
describes code this plan removes. A pre-edit hook (`doc-lock`) blocks other
comment changes. Carry intent in names, types, and tests. Do not edit any
Markdown file except this plan's status row in `plans/README.md`. The target
code below deliberately has no new comments.

## Commands you will need

| Purpose       | Command                                 | Expected on success |
|---------------|-----------------------------------------|---------------------|
| Typecheck     | `bun run typecheck`                     | exit 0, no errors   |
| Lint          | `bun run lint`                          | exit 0              |
| Format check  | `bun run fmt:check`                     | exit 0              |
| Boundaries    | `bun run lint:boundaries`               | exit 0              |
| Focused tests | `bun run test <path/to/file.test.ts>`   | all pass            |
| Full gate     | `bun run check`                         | exit 0              |
| Build         | `bun run build`                         | exit 0              |

The package manager is bun. Never use npm or npx. If `bun run fmt:check` fails
only on files you edited, run `bunx oxfmt --write <those files>` and re-check.

## Scope

**In scope** (the only files you should modify):

- `src/core/adapters/types.ts`
- `src/core/adapters/x/index.ts`
- `src/core/adapters/detection-store.ts`
- `src/entrypoints/overlay.content/index.tsx`
- `src/core/adapters/x/xadapter.test.ts`
- `src/core/adapters/detection-store.test.ts`
- `plans/README.md` (only this plan's status row, in the "Performance plans (012–023)" table)

**Out of scope** (do NOT touch, even though they look related):

- `resolveImageElement`, `photoIndexInArticle`, `resolveTweetContext` — their
  logic stays as it is. The memo makes them run rarely; rewriting them is not needed.
- `src/entrypoints/overlay.content/handlers.ts` and `post-grab.ts` — their
  `detectRenderedMedia` calls must stay full scans (two arguments).
- `src/core/adapters/instagram/` and `src/core/adapters/threads/` — their
  `detectRenderedMedia: () => []` already satisfies the widened signature.
- `queueRenderedMediaScan`, `scheduleScrollVideoRecovery`, and the scroll
  listener — scheduling does not change.

## Git workflow

- Branch: `advisor/012-skip-known-images-in-scroll-scan`
- Conventional commits. Example from this repo:
  `feat(relay): support Last-Modified validator, direct folder upload, and bump Convex to 1.46.0`.
  Use `perf(overlay): …` here.
- Do NOT push or open a PR.
- The working tree has uncommitted user changes, and some are in this plan's
  in-scope files (`src/core/adapters/detection-store.ts` at planning time).
  Never revert or stash them.
- Before editing, run the drift check command from the top of this plan. Note
  every in-scope file it lists: those files already hold uncommitted changes.
- Do not commit a file that had uncommitted changes before you started. Make
  the plan's edits in it, leave them unstaged, and name that file in your final
  message.
- Commit only in-scope files that were clean before you started. Stage each by
  explicit path.

## Steps

### Step 1: Write the failing memo tests

In `src/core/adapters/x/xadapter.test.ts`, inside the existing
`describe('detectRenderedImageElements', …)` block (starts near line 303), add
the four tests listed under "Test plan" items 1–4. Build the DOM the same way
the existing tests in that block do (`document.createElement('div')` plus
`root.innerHTML = …`). Build the memo as a plain object:

```ts
const memoFor = (detected: Set<string>) => ({
  resolved: new WeakMap<HTMLImageElement, { readonly src: string; readonly id: string | null }>(),
  isDetected: (id: string) => detected.has(id),
})
```

Each test calls `detectRenderedImageElements(root, pathname, memo)` and, after
each call, adds the returned ids to the `detected` set (this mirrors
`store.addDetected`).

**Verify**: `bun run test src/core/adapters/x/xadapter.test.ts` → the new
tests 1–3 FAIL (the third argument is ignored today, so the repeat scan still
returns items). `bun run typecheck` may also fail on the extra argument. Both
failures are expected at this step.

### Step 2: Add the memo type and widen the adapter signature

In `src/core/adapters/types.ts`, add this exported interface above
`PlatformAdapter`, and add the optional third parameter to `detectRenderedMedia`.
Keep the existing JSDoc on `detectRenderedMedia` unchanged.

```ts
export interface RenderedScanMemo {
  readonly resolved: WeakMap<HTMLImageElement, { readonly src: string; readonly id: string | null }>
  readonly isDetected: (id: string) => boolean
}
```

```ts
  detectRenderedMedia(root: ParentNode, pathname: string, memo?: RenderedScanMemo): MediaItem[]
```

**Verify**: `bun run typecheck` → no error in `types.ts`, `x/adapter.ts`,
`instagram/adapter.ts`, or `threads/adapter.ts`.

### Step 3: Make the scan skip fresh images

In `src/core/adapters/x/index.ts`:

1. Add `import type { RenderedScanMemo } from '../types'` with the other imports.
2. Add this helper directly above `detectRenderedImageElements`:

```ts
function imagesToResolve(
  imgs: ReadonlyArray<HTMLImageElement>,
  memo: RenderedScanMemo,
): ReadonlySet<HTMLImageElement> {
  const stale = new Set<HTMLImageElement>()
  const dirtyArticles = new Set<Element>()
  for (const img of imgs) {
    const prev = memo.resolved.get(img)
    const src = img.currentSrc || img.src
    const fresh =
      prev !== undefined && prev.src === src && (prev.id === null || memo.isDetected(prev.id))
    if (fresh) continue
    stale.add(img)
    const article = img.closest(TWEET_ARTICLE_SEL)
    if (article) dirtyArticles.add(article)
  }
  if (dirtyArticles.size === 0) return stale
  for (const img of imgs) {
    if (stale.has(img)) continue
    const article = img.closest(TWEET_ARTICLE_SEL)
    if (article && dirtyArticles.has(article)) stale.add(img)
  }
  return stale
}
```

3. Replace the body of `detectRenderedImageElements` with this shape. Keep the
   existing JSDoc line above the function and the existing `/* v8 ignore next … */`
   comment byte-for-byte.

```ts
export function detectRenderedImageElements(
  root: ParentNode,
  pathname = '',
  memo?: RenderedScanMemo,
): MediaItem[] {
  const out: MediaItem[] = []
  const seen = new Set<string>()
  const imgs = Array.from(root.querySelectorAll<HTMLImageElement>('img'))
  const stale = memo ? imagesToResolve(imgs, memo) : null
  for (const img of imgs) {
    if (stale && !stale.has(img)) continue
    const item = resolveImageElement(img, pathname)
    memo?.resolved.set(img, { src: img.currentSrc || img.src, id: item?.id ?? null })
    /* v8 ignore next -- item.url is always a grabbable /media/ photo with a valid key, so the `?? item.id` arm is dead */
    const key = item ? (mediaKeyFromUrl(item.url) ?? item.id) : null
    if (!item || !key || seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}
```

Why the "dirty article" second pass exists: a photo's `index` is its position
among the grabbable images of its article. When one image in an article is new
or changed, the indexes of its siblings can change, so the whole article is
re-resolved. Without a memo the function behaves exactly as before.

**Verify**: `bun run test src/core/adapters/x/xadapter.test.ts` → all pass,
including the new tests. `bun run typecheck` → exit 0.

### Step 4: Pass a memo from the scroll scan only

In `src/entrypoints/overlay.content/index.tsx`:

1. Add `RenderedScanMemo` as a type import from the adapters `types` module,
   using the same relative style as the existing line 4
   (`import { makeDetectionStore } from '../../core/adapters/detection-store'`):
   `import type { RenderedScanMemo } from '../../core/adapters/types'`. If the
   file already imports types from that module, add the name to that import.
2. Directly after the `const store = makeDetectionStore({ … })` statement
   (starts at line 717), add:

```ts
    const renderedScanMemo: RenderedScanMemo = {
      resolved: new WeakMap(),
      isDetected: (id) => store.get(id) !== undefined,
    }
```

3. Change `scanRenderedMedia` (line 874) to pass it:

```ts
    const scanRenderedMedia = (): void => {
      const rendered = adapter.detectRenderedMedia(document, location.pathname, renderedScanMemo)
      if (store.addDetected(rendered).length > 0) {
        rerender()
      }
    }
```

Do not change any other `detectRenderedMedia` call. The memo needs no reset on
`store.clear()`: after a clear, `isDetected` returns `false` for every
remembered id, so those images are resolved again on the next scan.

**Verify**:
`rg -n "detectRenderedMedia\(" src/entrypoints/overlay.content` → exactly one
call has three arguments (the one in `scanRenderedMedia`); the calls at
`index.tsx` Rescan, `handlers.ts` (two), and `post-grab.ts` still have two.
`bun run typecheck` → exit 0.

### Step 5: Stop copying the key index for the recovery scan

1. In `src/core/adapters/x/index.ts:275`, `src/core/adapters/types.ts:84`, and
   `src/core/adapters/detection-store.ts:171`, change the parameter type
   `detectedKeys: ReadonlySet<string>` to
   `detectedKeys: Pick<ReadonlySet<string>, 'has'>`. Do not change the
   `attemptedTweetIds` parameter.
2. In `src/core/adapters/detection-store.ts:307-308`, pass the map itself:

```ts
    needsRecovery: (root) => deps.findMediaNeedingRecovery?.(root, byKey, attempted) ?? [],
```

3. In `src/core/adapters/detection-store.test.ts`, add test 5 from the "Test
   plan" next to the existing `needsRecovery` tests (near line 178).

**Verify**: `bun run test src/core/adapters/detection-store.test.ts src/core/adapters/x/xadapter.test.ts src/core/adapters/x/adapter.test.ts`
→ all pass. `bun run typecheck` → exit 0.

### Step 6: Run the gate

**Verify**: `bun run check` → exit 0. `bun run build` → exit 0.

## Test plan

New tests in `src/core/adapters/x/xadapter.test.ts`, in the
`detectRenderedImageElements` block. Model them on the existing test
"collects rendered timeline photos using article status links as context"
(line 304). Use two articles: article A (`/alice/status/100`) with one photo
`https://pbs.twimg.com/media/A1?format=jpg&name=small` and one non-photo
`https://pbs.twimg.com/profile_images/nope.jpg`; article B (`/bob/status/200`)
with photos `B1` and `B2`.

1. **Repeat scan returns nothing** (fails before the change). First call with
   a memo returns ids `['A1', 'B1', 'B2']`. Add them to `detected`. Second call
   with the same memo returns `[]`.
2. **A changed `src` re-resolves its whole article, and only that article**
   (fails before the change). After test 1's setup, set B1's `src` to
   `https://pbs.twimg.com/media/B9?format=jpg&name=small`. The next call
   returns ids `['B9', 'B2']`. `A1` is absent.
3. **A cleared store re-resolves everything** (fails before the change, because
   the "nothing" baseline in it fails). After a scan and a `[]` repeat scan,
   empty the `detected` set. The next call returns `['A1', 'B1', 'B2']` again.
4. **No memo means a full scan every time** (passes before and after; a guard).
   Two calls with two arguments both return `['A1', 'B1', 'B2']`.

New test in `src/core/adapters/detection-store.test.ts`, modeled on
"needsRecovery wraps the injected finder with the store keys" (line 178):

5. **`needsRecovery` hands the finder a live lookup, not a copied Set** (fails
   before the change). Inject a `findMediaNeedingRecovery` spy that records its
   second argument and returns `[]`. Call `needsRecovery(root)`. Assert the
   recorded argument is not an instance of `Set`. Then add a detected item with
   `addDetected` and assert `recorded.has(<that item's key>)` is `true` without
   calling `needsRecovery` again.

Verification: `bun run test src/core/adapters/x/xadapter.test.ts src/core/adapters/detection-store.test.ts`
→ all pass, including 5 new tests.

## Done criteria

- [ ] `bun run check` exits 0
- [ ] `bun run build` exits 0
- [ ] The 5 new tests exist and pass
- [ ] `rg -n "new Set\(byKey.keys\(\)\)" src/core/adapters/detection-store.ts` returns no matches
- [ ] `rg -n "renderedScanMemo" src/entrypoints/overlay.content/index.tsx` returns exactly 2 matches (definition and the one use)
- [ ] `git status --short` shows no modified file outside the in-scope list that was not already modified before you started
- [ ] `git diff -U0 -- src | rg "^\+.*(oxlint-disable|eslint-disable|@ts-ignore|@ts-expect-error)"` returns no matches
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" does not match the excerpts.
- `detectRenderedImageElements` already takes a third parameter, or a memo of
  resolved images already exists in `index.tsx`.
- Any existing test in `xadapter.test.ts`, `detection-store.test.ts`,
  `handlers.test.ts`, or `post-grab.test.ts` fails after your change. Those
  tests describe full-scan behaviour that must not change.
- `Pick<ReadonlySet<string>, 'has'>` does not typecheck at a call site and the
  only fix you can see is an `as` cast. Report the error instead.
- The `doc-lock` hook rejects an edit. Report which edit and its message.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- **Behaviour change to review.** Before this plan, the per-frame DOM scan
  re-added every mounted photo, so a DOM-resolved item overwrote a
  network-captured item with the same media-key id on every frame. After this
  plan a photo is re-added only when it is stale, so a later network-captured
  item stays in the store. The ids are the same either way (ADR-0016). The
  network item carries the more reliable author and index. A reviewer should
  confirm no flow relied on the DOM item winning.
- **Assumption.** X mounts a tweet article's status links together with its
  images. If X ever mounts an article's permalink after its images without
  touching any `<img>`, a memoized photo could keep the page-path fallback
  context. The Rescan button does a full scan and repairs this.
- The memo holds images weakly (`WeakMap`). It adds no retention of DOM nodes.
- Deferred: `photoIndexInArticle` is still O(k²) per article when it runs. It
  now runs only for new or changed articles, so it was left alone.
- Deferred: `store.addDetected` still recomputes keys for each item it is
  given. With the memo it is given few items per frame.
