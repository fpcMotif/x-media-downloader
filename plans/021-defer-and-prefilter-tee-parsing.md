# Plan 021: Captured responses are parsed off the page's own response path, and Instagram/Threads bodies with no post media are never parsed

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 7456911 -- src/entrypoints/overlay.content/index.tsx src/core/adapters/types.ts src/core/adapters/instagram/adapter.ts src/core/adapters/threads/adapter.ts src/core/adapters/meta-shared`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED — a wrong pre-filter silently hides media. See the first STOP condition.
- **Depends on**: none. Coordinate with plan 016 (it edits the same teardown block in `index.tsx`); run the two plans one after the other, never in parallel.
- **Category**: perf
- **Planned at**: commit `7456911`, 2026-11-16

Excerpts were read from a working tree with uncommitted changes on top of this commit. Compare every excerpt with the live file before editing.

## Why this matters

A page-world script (the "tee") copies tracked network responses and hands
each body to the content script with a synchronous `document.dispatchEvent`.
The content script's listener runs `JSON.parse` and two or three full tree
walks inside that dispatch. For XHR responses the tee's `load` listener is
registered in `open()`, so it usually runs before the site's own handlers. The
site therefore waits for the extension's parse before it sees its own data.

On Instagram and Threads the tee's URL filter matches nearly every API call
(inbox, notifications, logging). Each one is parsed and walked even though it
holds no post media. At startup the content script also replays every inline
`<script type="application/json">` body back-to-back in one long task.

After this plan:

1. The listener only queues `(path, body)`. Parsing happens in a later task,
   one body per task.
2. On Instagram and Threads a cheap substring test runs before `JSON.parse`.
   A body that cannot contain a post with media is dropped unparsed.
3. The inline replay goes through the same queue, so the page can run between
   payloads.

The URL filter stays loose. That is a recorded choice (see below).

## Current state

Files:

- `src/entrypoints/overlay.content/index.tsx` — the content script. Holds the
  listener, the detection call, the inline replay, and teardown.
- `src/entrypoints/inject.content.ts` — the page-world tee. Read only.
- `src/core/adapters/types.ts` — the `PlatformAdapter` interface.
- `src/core/adapters/instagram/adapter.ts`, `src/core/adapters/threads/adapter.ts`
  — the two Meta adapters.
- `src/core/adapters/meta-shared/post-node.ts`, `media-node.ts`, `detect.ts`
  — the walkers. Read only. They define what a body must contain.
- `src/core/adapters/meta-shared/inline-data.ts` — collects inline script
  bodies. Read only.

The tee dispatch, `src/entrypoints/inject.content.ts:91-97`:

```ts
    const emit = (path: string, body: string): void => {
      if (import.meta.env.DEV)
        console.debug(
          `[XMD] tee emit · ${adapter.platform} · path=${path} · body=${body.length} chars`,
        )
      document.dispatchEvent(new CustomEvent('xmd:media-response', { detail: { path, body } }))
    }
```

The XHR hook, `src/entrypoints/inject.content.ts:151-156`:

```ts
          this.addEventListener('load', () => {
            if (this.status === 200) {
              try {
                const body = this.responseText
                if (withinTeeBudget(body, 'xhr body'))
                  emit(new URL(this.responseURL).pathname, body)
```

The listener, `src/entrypoints/overlay.content/index.tsx:1826-1847`:

```ts
    const handleMediaResponse = (event: CustomEvent<{ path: string; body: string }>): void => {
      const detail = event.detail
      let json: JsonValue
      try {
        json = JSON.parse(detail.body)
      } catch {
        if (import.meta.env.DEV)
          console.debug(
            `[XMD] media-response · ${adapter.platform} · path=${detail.path} · non-JSON body (${detail.body.length} chars), skipping`,
          )
        return /* non-JSON tee body */
      }
      // Ghost-vs-real discriminator upkeep — own try/catch, see
      // `trackFreshListMembership`'s doc — gated to X, the only platform its
      // Bookmarks/Likes path matching can ever fire on.
      if (adapter.platform === 'x') trackFreshListMembership(detail.path, json)
      detectAndStoreMedia(detail.path, json)
      // Knowledge Capture is X-only-forever (design spec Non-goals): harvestTweets'
      // tree walker assumes X's tweet-node JSON shape, so never call it off-platform.
      if (adapter.platform === 'x') harvestFrom(json, detail.path) // own try/catch — never swallowed by media path
    }
    document.addEventListener('xmd:media-response', handleMediaResponse)
```

A long comment block sits directly above this function (lines 1817-1825). It
states that `detail` is attacker-controlled: a page script can dispatch this
event itself with any shape. Keep that comment where it is.

`detectAndStoreMedia` (`index.tsx:1773-1815`) calls
`adapter.detectFromResponse(path, json)` and then
`adapter.extractPostCodes?.(json)`. On X it does not register post codes.

The inline replay, `src/entrypoints/overlay.content/index.tsx:1963-1974`:

```ts
    if (adapter.platform === 'instagram' || adapter.platform === 'threads') {
      const inlineBodies = inlineDataPayloads(document.scripts)
      if (import.meta.env.DEV)
        console.debug(
          `[XMD] inline-data replay · ${adapter.platform} · ${inlineBodies.length} candidate script(s)`,
        )
      for (const body of inlineBodies) {
        document.dispatchEvent(
          new CustomEvent('xmd:media-response', { detail: { path: 'inline:document', body } }),
        )
      }
    }
```

Teardown, `src/entrypoints/overlay.content/index.tsx:2338-2341`:

```ts
      browser.runtime?.onMessage?.removeListener(handleRuntimeMessage)
      document.removeEventListener('xmd:media-response', handleMediaResponse)
      document.removeEventListener(TEE_DROP_EVENT, handleTeeDrop)
    })
```

What the Meta walkers need. Post identity,
`src/core/adapters/meta-shared/post-node.ts:36-45`:

```ts
function postContext(node: JsonObject): PostContext | null {
  const code = node['code']
  const user = node['user']
  if (!isJsonString(code) || code === '' || !isJsonObject(user)) return null
  const username = user['username']
  if (!isJsonString(username) || username === '') return null
  const pk = node['pk']
  const postId = isJsonString(pk) || isJsonNumber(pk) ? String(pk) : code
  return { postId, code, author: username }
}
```

Media, `src/core/adapters/meta-shared/media-node.ts:102-126`:

```ts
  const carousel = node['carousel_media']
  if (Array.isArray(carousel) && carousel.length > 0) {
    return carousel.flatMap((child) => mediaNodesFromPost(child, visiting))
  }

  const videoVersions = candidatesOf(node['video_versions'])
  if (videoVersions.length > 0) {
    // …
    return [nodeFromCandidate('video', best)]
  }

  const imageVersions2 = node['image_versions2']
  const imageCandidates = isJsonObject(imageVersions2)
    ? candidatesOf(imageVersions2['candidates'])
    : []
  // …
  return []
```

Both `detectMediaItems` and `postCodesInResponse`
(`src/core/adapters/meta-shared/detect.ts:62-117`) visit only nodes for which
`postContext` is non-null. So:

- A body with no `"code"` key or no `"username"` key yields zero posts.
- A post yields media only through a `video_versions` or `image_versions2`
  key (carousel children use the same two keys).

Therefore a body can produce a `MediaItem` only if its text contains
`"code"` AND `"username"` AND (`"video_versions"` OR `"image_versions2"`).
This is the pre-filter. It is derived from the walkers, not guessed.

A body that passes identity but has no media key would today register post
codes and no media. Skipping it changes nothing a user can see: a code link
is only used to find a stored `MediaItem` for that post, and any later
response that carries the post's media also carries its `code`, so the link
is registered then.

The adapter interface already has one optional Meta-only hook,
`src/core/adapters/types.ts:95`:

```ts
  extractPostCodes?(json: JsonValue): ReadonlyMap<string, string>
```

Both Meta adapters set it: `src/core/adapters/instagram/adapter.ts:288` and
`src/core/adapters/threads/adapter.ts:244` — `extractPostCodes: postCodesInResponse,`.

The recorded choice to keep the URL filter loose,
`src/core/adapters/instagram/adapter.ts:176-184`:

> Deliberately loose by design, not just for lack of verification: a
> false-positive URL match only costs one wasted JSON parse that structurally
> finds nothing … A narrower filter would only reduce wasted parses, at the
> risk of a false negative silently dropping real media capture

ADR-0001 (`docs/adr/0001-passive-first-extraction.md`) decides passive
capture through the tee. This plan does not change what the tee captures. It
changes when the content script parses, and skips bodies the walkers provably
cannot use.

X is different. On X the listener also runs `trackFreshListMembership` and
`harvestFrom` (text capture), which need tweets with no media. **X gets the
deferral only. X gets no pre-filter.**

WXT's content-script context offers `ctx.setTimeout(handler, timeout)`
(`node_modules/wxt/dist/utils/content-script-context.d.mts:89`). It is
cancelled automatically when the context is invalidated. `index.tsx` already
uses `ctx.requestAnimationFrame` the same way (for example line 888).

Test exemplars:

- `src/entrypoints/overlay.content/saved-status-lifecycle.test.ts` — a factory
  tested with an injected fake clock. Model the queue test on it.
- `src/core/adapters/hover-resolve.property.test.ts` — a `fast-check`
  property test (`import * as fc from 'fast-check'`).
- `src/entrypoints/overlay.content/accessibility.test.ts` — reads
  `index.tsx` as text (`readFileSync`) and asserts on substrings.

Repo conventions that apply (from `AGENTS.md`):

- No `oxlint-disable`, `@ts-ignore`, or `@ts-expect-error`.
- Every `as` needs an uppercase `SAFETY:` comment. Prefer narrowing.
- `unknown` is banned in parameters, returns and type aliases.
- Named constants, not magic numbers. Regex and constant tables at module top
  level.
- `try`/`catch` must do something. Never catch only to rethrow.
- Tests are vitest with assertions inside `it()`.

Comment rule: do not add, edit, or delete code comments, except a comment that
describes code this plan removes. A pre-edit hook (`doc-lock`) blocks other
comment changes. Carry intent in names, types and tests. Do not edit any
Markdown file except this plan's status row in `plans/README.md`. The new
interface member gets no JSDoc; report that so the owner can add one.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `bun run typecheck` | exit 0 |
| Lint | `bun run lint` | exit 0 |
| Format check | `bun run fmt:check` | exit 0 |
| Boundaries | `bun run lint:boundaries` | exit 0 |
| Focused tests | `bun run test <path/to/file.test.ts>` | all pass |
| Full gate | `bun run check` | exit 0 |
| Build | `bun run build` | exit 0 |

Package manager is bun. Never use npm or npx.

## Scope

**In scope** (the only files you should modify):

- `src/core/adapters/meta-shared/body-prefilter.ts` (create)
- `src/core/adapters/meta-shared/body-prefilter.test.ts` (create)
- `src/core/adapters/types.ts` (one optional member)
- `src/core/adapters/instagram/adapter.ts` (one property)
- `src/core/adapters/threads/adapter.ts` (one property)
- `src/entrypoints/overlay.content/response-queue.ts` (create)
- `src/entrypoints/overlay.content/response-queue.test.ts` (create)
- `src/entrypoints/overlay.content/index.tsx`
- `src/core/adapters/instagram/adapter.test.ts` (append one `it`)
- `src/core/adapters/threads/adapter.test.ts` (append one `it`)
- `src/core/adapters/x/adapter.test.ts` (append one `it`). This is the file
  that imports `xAdapter` from `./adapter`. Do not use
  `src/core/adapters/x/xadapter.test.ts`; that file tests other X modules.
- `plans/README.md` (only this plan's status row in the
  "Performance plans (012–023)" table)

**Out of scope** (do NOT touch):

- `src/entrypoints/inject.content.ts` — the tee, its budget and its drop
  events stay as they are.
- `isTrackedInstagramResponseUrl`, `isTrackedThreadsResponseUrl`, and the X
  URL filter — the URL filters stay loose.
- `src/core/adapters/meta-shared/inline-data.ts` — its doc says it does no
  filtering. The filter belongs to the consumer.
- `src/core/adapters/meta-shared/detect.ts`, `post-node.ts`, `media-node.ts`.
- `src/core/adapters/x/*` — X gets no pre-filter.
- `handleMutationResponse` and the `xmd:mutation-response` listener — plan
  016 owns that.
- Merging the two or three JSON walks into one — a separate finding.

## Git workflow

- Branch: `advisor/021-defer-and-prefilter-tee-parsing`
- Conventional commits. Example from this repo:
  `feat(relay): support Last-Modified validator, direct folder upload, and bump Convex to 1.46.0`.
  Use `perf(overlay): …` and `perf(adapters): …`.
- Do NOT push or open a PR.
- The working tree has uncommitted user changes. Never revert or stash them.
- Before editing, run the drift-check command from the top of this plan and
  note which in-scope files already show uncommitted changes.
- Do not commit a file that had uncommitted changes before you started. Leave
  this plan's edits unstaged in that file and name the file in your final
  message.
- Commit only in-scope files that were clean before you started. Stage them by
  path.

## Steps

### Step 1: Add the Meta body pre-filter with tests

Create `src/core/adapters/meta-shared/body-prefilter.ts`:

```ts
const POST_IDENTITY_KEYS = ['"code"', '"username"'] as const
const POST_MEDIA_KEYS = ['"video_versions"', '"image_versions2"'] as const

export const bodyMayContainPostMedia = (body: string): boolean =>
  POST_IDENTITY_KEYS.every((key) => body.includes(key)) &&
  POST_MEDIA_KEYS.some((key) => body.includes(key))
```

Create `src/core/adapters/meta-shared/body-prefilter.test.ts` with:

1. A body built with `JSON.stringify` from a post that has `code`,
   `user.username`, and `image_versions2.candidates` → `true`.
2. The same with `video_versions` instead → `true`.
3. A carousel post (`carousel_media` children holding `image_versions2`) →
   `true`.
4. A body with identity keys but no media key → `false`.
5. A body with a media key but no `"code"` → `false`.
6. A non-JSON string → `false`.
7. **The soundness property (the important one).** Use `fast-check`, in the
   style of `src/core/adapters/hover-resolve.property.test.ts` (typed
   `fc.Arbitrary<…>` constants at module level, then `fc.assert(fc.property(…))`
   inside an `it`). Use exactly this:

   ```ts
   import * as fc from 'fast-check'
   import type { JsonValue } from '@/packages/schema'
   import { detectMediaItems } from './detect'
   import { bodyMayContainPostMedia } from './body-prefilter'

   const WALKER_KEYS = [
     'code',
     'user',
     'username',
     'pk',
     'carousel_media',
     'video_versions',
     'image_versions2',
     'candidates',
     'url',
     'width',
     'height',
     'items',
     'data',
   ] as const

   const MAX_JSON_DEPTH = 5
   const PROPERTY_RUNS = 500

   const leafArb: fc.Arbitrary<JsonValue> = fc.oneof(
     fc.constantFrom<JsonValue>(
       'abc',
       '',
       'https://scontent.cdninstagram.com/v/a.jpg',
       'https://scontent.cdninstagram.com/v/b.mp4',
     ),
     fc.integer({ min: 0, max: 2000 }),
     fc.constant(null),
   )

   const { value: jsonArb } = fc.letrec<{ value: JsonValue }>((tie) => ({
     value: fc.oneof(
       { maxDepth: MAX_JSON_DEPTH },
       leafArb,
       fc.array(tie('value'), { maxLength: 3 }),
       fc.dictionary(fc.constantFrom(...WALKER_KEYS), tie('value'), { maxKeys: 5 }),
     ),
   }))

   it('never rejects a body the detector can read media from', () => {
     fc.assert(
       fc.property(jsonArb, (value) => {
         const body = JSON.stringify(value)
         if (bodyMayContainPostMedia(body)) return
         expect(detectMediaItems(value, 'instagram')).toEqual([])
       }),
       { numRuns: PROPERTY_RUNS },
     )
   })
   ```

   `as const` on the key list is a const assertion and needs no `SAFETY:`
   comment. Do not add any other `as`. If the arbitrary does not typecheck,
   change its shape (for example give `fc.array` and `fc.dictionary` an
   explicit `fc.Arbitrary<JsonValue>` annotation through a named constant).
   If two attempts fail, STOP and report the type error.
8. One hand-written positive for the property: take one real-shaped fixture
   from `src/core/adapters/meta-shared/detect.test.ts` for which
   `detectMediaItems` returns at least one item, and assert
   `bodyMayContainPostMedia(JSON.stringify(fixture))` is `true`.

**Verify**: `bun run test src/core/adapters/meta-shared/body-prefilter.test.ts`
→ all pass. If the property test finds a counterexample, STOP (first STOP
condition).

### Step 2: Expose the pre-filter on the two Meta adapters

1. `src/core/adapters/types.ts`: directly below the `extractPostCodes?` member
   (line 95), add:

```ts
  responseBodyMayContainMedia?(body: string): boolean
```

2. `src/core/adapters/instagram/adapter.ts`: import
   `bodyMayContainPostMedia` from `../meta-shared/body-prefilter` and add,
   next to `extractPostCodes: postCodesInResponse,`:

```ts
  responseBodyMayContainMedia: bodyMayContainPostMedia,
```

3. `src/core/adapters/threads/adapter.ts`: the same two edits.

Do NOT add it to the X adapter.

Required tests (all three files are in scope; append only, do not
restructure):

- `src/core/adapters/instagram/adapter.test.ts`: one `it` asserting the
  Instagram adapter's `responseBodyMayContainMedia?.('{"status":"ok"}')` is
  `false`.
- `src/core/adapters/threads/adapter.test.ts`: the same for the Threads
  adapter.
- `src/core/adapters/x/adapter.test.ts`: one `it` asserting
  `xAdapter.responseBodyMayContainMedia` is `undefined`.

Use the adapter export name each test file already imports.

**Verify**: `bun run typecheck` → exit 0.
`bun run test src/core/adapters` → all pass.

### Step 3: Add the response queue with tests

Create `src/entrypoints/overlay.content/response-queue.ts`:

```ts
import type { JsonValue } from '@/packages/schema'

export interface MediaResponseDetail {
  readonly path: string
  readonly body: string
}

export interface ParsedMediaResponse {
  readonly path: string
  readonly json: JsonValue
}

export const parseMediaResponseDetail = (
  detail: MediaResponseDetail,
  mayContainMedia: (body: string) => boolean | undefined,
): ParsedMediaResponse | null => {
  try {
    const { path, body } = detail
    if (mayContainMedia(body) === false) return null
    const json: JsonValue = JSON.parse(body)
    return { path, json }
  } catch {
    return null
  }
}

export interface ResponseQueue {
  readonly enqueue: (detail: MediaResponseDetail) => void
  readonly dispose: () => void
}

export interface ResponseQueueDeps {
  readonly schedule: (run: () => void) => void
  readonly process: (detail: MediaResponseDetail) => void
}

export const makeResponseQueue = (deps: ResponseQueueDeps): ResponseQueue => {
  let pending: MediaResponseDetail[] = []
  let scheduled = false
  let disposed = false

  const drainOne = (): void => {
    scheduled = false
    if (disposed) return
    const next = pending.shift()
    if (next === undefined) return
    try {
      deps.process(next)
    } finally {
      arm()
    }
  }

  const arm = (): void => {
    if (scheduled || disposed || pending.length === 0) return
    scheduled = true
    deps.schedule(drainOne)
  }

  return {
    enqueue: (detail) => {
      if (disposed) return
      pending.push(detail)
      arm()
    },
    dispose: () => {
      disposed = true
      pending = []
    },
  }
}
```

Why the queue holds the whole `detail` object. A page script can forge this
event with any `detail`, including `null`. The listener must therefore read no
field of `detail`. It hands the value to the queue untouched.
`parseMediaResponseDetail` reads `path` and `body` INSIDE its `try`, so a
forged `detail` (null, missing fields, a non-string `body`) ends in the same
`catch` as a non-JSON body and returns `null`. This keeps the promise made by
the `SAFETY:` comment above `handleMediaResponse` in `index.tsx`.

`const json: JsonValue = JSON.parse(body)` uses an annotation, not `as`. The
current code does the same (`let json: JsonValue` … `json = JSON.parse(…)`).

Create `src/entrypoints/overlay.content/response-queue.test.ts`. Use a fake
scheduler: `const tasks: (() => void)[] = []` and
`schedule: (run) => { tasks.push(run) }`. A helper `runNext()` shifts one task
and calls it. Cases:

Queue items are `{ path, body }` objects, for example
`{ path: 'p', body: 'a' }`.

1. **Nothing is processed synchronously.** `enqueue({ path: 'p', body: 'b' })`;
   expect `process` not called and `tasks.length` to be `1`.
2. **One body per task, in order.** Enqueue `a`, `b`, `c`. Expect one
   scheduled task. `runNext()` → `process` called once with `a`, and one new
   task scheduled. Repeat; final order is `a`, `b`, `c`.
3. **A throwing `process` does not stop the queue.** `process` throws on the
   first body. `expect(() => runNext()).toThrow()`. Then `runNext()` processes
   the second body.
4. **`dispose` drops pending work.** Enqueue two, `dispose()`, run every
   scheduled task; `process` never called. A later `enqueue` schedules
   nothing.
5. **No double scheduling.** Enqueue three bodies before running any task;
   `tasks.length` stays `1`.

Cases for `parseMediaResponseDetail`, in a second `describe`:

6. A JSON body with no filter (`() => undefined`) → returns
   `{ path, json }` with the parsed value.
7. A filter that returns `false` → returns `null`, and the body is not
   parsed (pass a body that is invalid JSON and still expect `null` with no
   throw; then pass a valid body and a filter spy, and expect the spy to have
   been called with the body).
8. A filter that returns `true` and a non-JSON body → `null`.
9. **A forged event whose `detail` is `null` does not throw.** Dispatch a real
   event (the vitest environment is `happy-dom`). No cast is needed:

```ts
  it('a forged event with a null detail yields null and does not throw', () => {
    const seen: (ParsedMediaResponse | null)[] = []
    const listener = (event: CustomEvent<MediaResponseDetail>): void => {
      seen.push(parseMediaResponseDetail(event.detail, () => undefined))
    }
    document.addEventListener('xmd:media-response', listener)
    expect(() =>
      document.dispatchEvent(new CustomEvent('xmd:media-response', { detail: null })),
    ).not.toThrow()
    document.removeEventListener('xmd:media-response', listener)
    expect(seen).toEqual([null])
  })
```

   The event name is typed by the `DocumentEventMap` augmentation in
   `src/entrypoints/overlay.content/index.tsx` (near line 123). The
   `expect(seen).toEqual([null])` line is the real assertion: it proves the
   listener ran to completion and the parse returned `null`.
10. A forged detail with a non-string body. Dispatch
    `new CustomEvent('xmd:media-response', { detail: { path: 'p', body: 42 } })`
    through the same listener, with a filter `(body) => body.includes('x')`.
    Expect `seen` to equal `[null]`.

**Verify**: `bun run test src/entrypoints/overlay.content/response-queue.test.ts`
→ all pass.

### Step 4: Route the listener and the inline replay through the queue

In `src/entrypoints/overlay.content/index.tsx`:

1. Import `makeResponseQueue`, `parseMediaResponseDetail` and the type
   `MediaResponseDetail` from `./response-queue`.

2. Split `handleMediaResponse`. Keep the comment block above it (the one that
   starts "Named so invalidation can remove it" and contains the `SAFETY:`
   lines, near lines 1820-1828) exactly where it is, directly above
   `handleMediaResponse`. Declare the new processing function and the queue
   just ABOVE that comment block:

```ts
    const processMediaResponse = (detail: MediaResponseDetail): void => {
      const parsed = parseMediaResponseDetail(detail, (body) =>
        adapter.responseBodyMayContainMedia?.(body),
      )
      if (parsed === null) {
        if (import.meta.env.DEV)
          console.debug(
            `[XMD] media-response · ${adapter.platform} · skipped (pre-filtered, unreadable, or non-JSON body)`,
          )
        return
      }
      const { path, json } = parsed
      // Ghost-vs-real discriminator upkeep — own try/catch, see
      // `trackFreshListMembership`'s doc — gated to X, the only platform its
      // Bookmarks/Likes path matching can ever fire on.
      if (adapter.platform === 'x') trackFreshListMembership(path, json)
      detectAndStoreMedia(path, json)
      // Knowledge Capture is X-only-forever (design spec Non-goals): harvestTweets'
      // tree walker assumes X's tweet-node JSON shape, so never call it off-platform.
      if (adapter.platform === 'x') harvestFrom(json, path) // own try/catch — never swallowed by media path
    }

    const responseQueue = makeResponseQueue({
      schedule: (run) => {
        ctx.setTimeout(run, 0)
      },
      process: processMediaResponse,
    })
```

   The three comments in this block are the existing ones, copied verbatim
   from the live file (near lines 1841-1848). They move with the statements
   they describe. Compare them character by character with the live file
   before you paste; if the live text differs, use the live text. The old
   inline `/* non-JSON tee body */` comment and the old DEV log leave with the
   `try`/`catch` they described, which now lives in
   `parseMediaResponseDetail`. If the `doc-lock` hook rejects the move, STOP
   and report.

   The filter is passed as an arrow function, not as
   `adapter.responseBodyMayContainMedia`. A bare method reference trips the
   `unbound-method` lint rule.

   Then make the listener only enqueue. It reads no field of `detail`:

```ts
    const handleMediaResponse = (event: CustomEvent<{ path: string; body: string }>): void => {
      responseQueue.enqueue(event.detail)
    }
    document.addEventListener('xmd:media-response', handleMediaResponse)
```

3. Inline replay: replace the `document.dispatchEvent(new CustomEvent(...))`
   call inside the `for` loop with:

```ts
        responseQueue.enqueue({ path: 'inline:document', body })
```

   Keep the `if (adapter.platform === 'instagram' || …)` gate, the DEV log,
   and the comment above the block.

4. Teardown: in the `ctx.onInvalidated` block, directly after
   `document.removeEventListener('xmd:media-response', handleMediaResponse)`,
   add:

```ts
      responseQueue.dispose()
```

5. Add a source-text test to
   `src/entrypoints/overlay.content/response-queue.test.ts` (same pattern as
   `accessibility.test.ts`: `readFileSync('src/entrypoints/overlay.content/index.tsx', 'utf8')`):

   - the source contains `responseQueue.enqueue(event.detail)`
   - the source contains `responseQueue.enqueue({ path: 'inline:document', body })`
   - the source contains `responseQueue.dispose()`
   - the source does NOT contain `json = JSON.parse(detail.body)`
   - the source contains
     `adapter.responseBodyMayContainMedia?.(body),`

   These fail on the current source and pass after this step.

**Verify**:
- `bun run test src/entrypoints/overlay.content` → all pass.
- `bun run typecheck` → exit 0.

### Step 5: Full gate and manual check

**Verify**: `bun run check` → exit 0. Then `bun run build` → exit 0.

Manual check (report the result; do not skip silently if you cannot run a
browser — say so):

1. Load the built extension. Open an Instagram profile grid and a Threads
   feed. Scroll. Hover photos and videos. The badge must appear and a grab
   must download, exactly as before.
2. Cold-load an Instagram reel URL directly. The first reel must be
   grabbable (this is the inline-replay path).
3. Open X, scroll the home timeline, grab a photo and a video.

## Test plan

- `body-prefilter.test.ts`: 8 cases, including the `fast-check` soundness
  property "filter says no ⇒ detector finds nothing". The expectation comes
  from the requirement that the filter never hides media, not from the
  filter's own code.
- `response-queue.test.ts`: 5 queue cases, 5 parse cases (including the
  forged `detail: null` event), plus the source-text checks.
  Case 1 encodes the requirement "the listener does no parsing inside the
  dispatch". The source-text checks fail before Step 4 and pass after.
- Appended adapter tests: Meta adapters expose the filter, X does not.
- Verification: `bun run test src/core/adapters src/entrypoints/overlay.content`
  → all pass.

## Done criteria

ALL must hold:

- [ ] `bun run check` exits 0
- [ ] `bun run build` exits 0
- [ ] `rg -n "JSON.parse\(detail.body\)" src/entrypoints/overlay.content/index.tsx` returns no matches
- [ ] `rg -n "responseQueue\.(enqueue|dispose)" src/entrypoints/overlay.content/index.tsx` returns 3 matches
- [ ] `rg -n "responseBodyMayContainMedia" src/core/adapters/x` returns matches only in `adapter.test.ts`
- [ ] `git diff --stat 7456911 -- src/entrypoints/inject.content.ts` shows no change made by this plan
- [ ] The `fast-check` property in `body-prefilter.test.ts` passes
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- **Any sign of missed media.** The `fast-check` property finds a
  counterexample; or any existing fixture in
  `src/core/adapters/meta-shared/detect.test.ts`,
  `instagram/adapter.test.ts` or `threads/adapter.test.ts` produces a
  `MediaItem` from a body the filter rejects; or the manual check shows a
  photo or video that is no longer grabbable. Do not loosen or tighten the
  key list yourself. Report the body shape.
- `postContext` in `post-node.ts` or `mediaNodesFromPost` in `media-node.ts`
  no longer reads exactly the keys quoted in "Current state". The filter is
  derived from those keys and must be re-derived by the plan author.
- `registerPostCode` or `extractPostCodes` has gained a consumer that needs
  post codes from responses with no media (search:
  `rg -n "registerPostCode|extractPostCodes" src`). The filter would starve
  it.
- Any code or test reads detection results synchronously right after
  dispatching `xmd:media-response` (search:
  `rg -n "xmd:media-response" src tools`). At planning time the only
  dispatchers were the tee and the inline replay.
- `ctx.setTimeout` is not available on the WXT context in this checkout.
  Report it; do not swap in a different scheduler without approval.
- The `doc-lock` hook blocks moving a comment with its statement.
- A verification fails twice after a reasonable fix attempt.

## Maintenance notes

- The filter is a text test for JSON keys. It assumes the server writes keys
  as plain `"code"`, not as `\u`-escaped text. Instagram and Threads do. If
  that ever changes, detection drops to zero on those platforms and the DEV
  log line `detected=0` will show it.
- When the Meta walkers learn a new media shape (a new key beside
  `video_versions` and `image_versions2`), add that key to
  `POST_MEDIA_KEYS` in the same change. The property test will fail if the
  generator's key alphabet is extended and the filter is not. Extend the
  alphabet whenever the walker reads a new key.
- Detection now lands one task later than the response. Timers are throttled
  in background tabs, so a hidden tab drains its queue slowly. Bodies wait in
  memory until processed (each up to 8 MiB, the tee's cap).
- Plan 016 edits the same `ctx.onInvalidated` block. Whichever lands second
  must re-read the block.
- Plan 007 (split the overlay content controller) will move this code. The
  queue is already its own module, which makes that split easier.
- Not done here: giving the tee a way to avoid cloning non-media responses at
  all. That would need the filter in the page world and changes ADR-0001's
  surface. Left for the owner.
- Reviewer: confirm X still runs `trackFreshListMembership` and `harvestFrom`
  for every tracked response, and that no pre-filter reaches X.
