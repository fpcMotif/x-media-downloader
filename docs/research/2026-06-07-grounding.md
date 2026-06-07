# X Media Downloader — Build Grounding (version-correct canonical patterns)

- **Date:** 2026-06-07
- **Status:** Authoritative pre-build grounding. Supersedes any conflicting API
  usage in the spec/plan. All Effect snippets compiled clean (`tsc 6.0.3
  --strict --exactOptionalPropertyTypes --noUncheckedIndexedAccess`, exit 0)
  against the **installed** `effect@4.0.0-beta.78`. All Chrome/WXT claims are
  grounded in official docs + the version-matched `study/wxt-repo` (WXT 0.20.26)
  and `study/TwitterMediaHarvest` prior art.

> **Why this doc exists:** the committed spec/plan were drafted against **Effect
> v3** idioms (`Effect.Service`, `Schema.decodeUnknownEither`,
> `Schema.optionalWith`, `@effect/schema`) and an over-optimistic view of MV3
> service-worker lifetime. None of those compile or hold under the installed
> stack. This document pins the APIs we will actually call. See
> **§9 Corrections to spec/plan**.

---

## 0. Installed versions (the only source of truth)

| Package | Version | Notes |
|---|---|---|
| `effect` | `4.0.0-beta.78` | the "effect-smol" rewrite; `Schema`, `Semaphore`, `Result` are **in core** (`import { … } from "effect"`). There is **no** `@effect/schema` package installed and we must not add one. |
| `wxt` | `0.20.26` | matches `study/wxt-repo`. |
| `@wxt-dev/storage` | `1.2.8` | `removeValue()` (not `deleteValue()`). |
| `preact` | `10.29.2` | via `@preact/preset-vite` (no official WXT Preact module). |
| `typescript` | `6.0.3` | `baseUrl` deprecated (needs `ignoreDeprecations:"6.0"`); prefer `paths` only. |

```bash
node -e "console.log(require('effect/package.json').version)"   # 4.0.0-beta.78
grep -c "Effect.Service" node_modules/effect/dist/Effect.d.ts     # 0  (does NOT exist)
grep -c "decodeUnknownEither" node_modules/effect/dist/Schema.d.ts # 0  (does NOT exist)
grep -c "optionalWith" node_modules/effect/dist/Schema.d.ts        # 0  (does NOT exist)
ls node_modules/@effect/schema                                     # ENOENT (not installed)
```

---

## (a) Chrome MV3 manifest & permissions

WXT generates `manifest.json` from `wxt.config.ts` + entrypoints. We only declare
`permissions` + `host_permissions`. The current config is correct and minimal:

```ts
// wxt.config.ts (current — keep)
manifest: {
  permissions: ['downloads', 'storage'],          // downloads => one unavoidable
                                                   // "Manage your downloads" install warning;
                                                   // storage is silent. No activeTab, no cookies,
                                                   // no webRequest, no scripting.
  host_permissions: [
    'https://x.com/*', 'https://twitter.com/*',    // content-script injection + tab url/title
    'https://pbs.twimg.com/*', 'https://video.twimg.com/*', // SW-side media fetch (path B, see (d))
  ],
}
```

Load-bearing constraints (official docs):

- **`downloads` is NOT warning-free** — it triggers the "Manage your downloads"
  install warning. Unavoidable given core function. `storage` is silent.
  (`/docs/extensions/reference/permissions-list`)
- **Content-script `fetch()` cannot bypass CORS with `host_permissions`** —
  "Cross-origin requests are always treated as such in content scripts, even if
  the extension has host permissions." → **all CDN media fetches must run in the
  service worker**, never the content script.
  (`/docs/extensions/develop/concepts/network-requests`)
- **`chrome.downloads.download()` needs only the `downloads` permission**, NOT
  `host_permissions` for the file URL. The twimg `host_permissions` are required
  only if we `fetch()` the bytes in the SW first (probing/renaming). We plan
  **path B** (fetch in SW for quality probing) → keep the two CDN hosts.
- **`world:"MAIN"` content scripts need NO `web_accessible_resources`**; only
  WXT `injectScript()` (page-loads-extension-file-by-URL) does. We use a
  declarative `world:"MAIN"` entry (Chromium-only target), so WAR stays empty.
- **CSP is locked**: default `script-src 'self'; object-src 'self';`. No remote
  JS, no `eval`, no CDN libs. Bundle Effect + Preact. No remote-code rule from
  CWS policy applies to the MAIN-world tee → it must be a build-time bundle.
- Match-pattern path is required-but-ignored → always write `/*`.

---

## (b) Background service worker + DownloadQueue survival

MV3 background is an **event-driven service worker**, terminated after **30s
idle**; single event/promise capped at **5 min**; a `fetch()` whose response
takes **>30s** is aborted. **In-memory state (Effect `Ref`/`Semaphore`/`PubSub`
subscribers, module vars) is lost on termination.** No `window`/`document`/
`localStorage` in a SW.

Two non-negotiables:

1. **Register listeners synchronously at the top of `main()`** (which **cannot be
   async**). Cold-start events are dropped if you `addListener` after an `await`.
2. **Persist queue state** (downloadId + per-item status + rendered filename) to
   `chrome.storage` so it survives recycling; rehydrate + reconcile via
   `chrome.downloads.search` on restart.

```ts
// src/entrypoints/background.ts — WXT
export default defineBackground({
  type: 'module',
  main() {                                  // CANNOT be async (WXT entrypoints.md:201)
    // 1) Register ALL listeners synchronously, FIRST:
    browser.runtime.onInstalled.addListener(seedDefaults)
    browser.runtime.onStartup.addListener(rehydrateQueue)
    browser.downloads.onChanged.addListener(onDownloadChanged) // drives progress/retry
    browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      void Effect.runPromise(handle(msg).pipe(Effect.provide(AppLive)))
        .then(sendResponse)
      return true                            // keep channel open for async reply
    })
    // 2) THEN do async setup (build runtime, hydrate) fire-and-forget:
    void Effect.runPromise(bootstrap.pipe(Effect.provide(AppLive)))
  },
})
```

**DownloadQueue redesign (critical):** the browser owns the transfer. Each
`chrome.downloads.download()` returns a `downloadId` immediately and the file
keeps downloading **even if the SW is killed**; `chrome.downloads.onChanged`
wakes the SW to report `state: in_progress → complete | interrupted`. Therefore:

- `downloadOne` **fires** `download()` and **does not await file completion**
  inside one handler (avoids the 5-min cap). Concurrency is bounded by a
  `Semaphore` over the *number of in-flight `download()` starts*, not over awaited
  completions.
- Progress/retry is driven by the top-level `onChanged` listener, bridged into
  Effect (e.g. resolve a `Deferred` per downloadId). **Byte progress is NOT in
  `onChanged`** — poll `chrome.downloads.search({id})` for `bytesReceived/
  totalBytes` (guard `totalBytes === -1`).
- The live popup obtains progress by **messaging the SW** (which rehydrates from
  storage), not by holding a long-lived `Stream` that dies silently on recycle.

Use `chrome.alarms` (min 30s) for periodic reconciliation — never `setInterval`
or keep-alive hacks.

---

## (c) MAIN-world fetch/XHR tee + handoff

Two cooperating scripts (mirrors TwitterMediaHarvest, validated in production):

```ts
// src/entrypoints/inject.content.ts  — MAIN world, runs in page's JS realm
export default defineContentScript({
  matches: ['*://x.com/*', '*://twitter.com/*'],
  world: 'MAIN',
  runAt: 'document_start',          // MUST be document_start — default document_idle is too late;
                                    // X grabs native fetch/XHR before then.
  main() {                          // NO ctx, NO chrome.* here
    const origOpen = XMLHttpRequest.prototype.open
    XMLHttpRequest.prototype.open = new Proxy(origOpen, {
      apply(target, thisArg, args) {
        const url = String(args[1] ?? '')
        if (isGraphqlMediaUrl(url)) {
          thisArg.addEventListener('load', function (this: XMLHttpRequest) {
            if (this.status === 200) {
              document.dispatchEvent(new CustomEvent('xmd:media-response', {
                detail: { path: new URL(this.responseURL).pathname, body: this.responseText },
              }))
            }
          })
        }
        return Reflect.apply(target, thisArg, args)   // transparent: page request still works
      },
    })
    // OPTIONAL hardening — also patch window.fetch (TMH ships XHR-only and works;
    // X currently uses XHR, but patch fetch too in case it migrates endpoints):
    const origFetch = window.fetch
    window.fetch = async (...a) => {
      const res = await origFetch(...a)
      try {
        const u = new URL((a[0] as Request).url ?? String(a[0]), location.origin)
        if (isGraphqlMediaUrl(u.href) && res.ok) {
          res.clone().text().then((body) =>
            document.dispatchEvent(new CustomEvent('xmd:media-response',
              { detail: { path: u.pathname, body } })))
        }
      } catch { /* never break the page */ }
      return res                                    // ALWAYS return untouched response
    }
  },
})
```

```ts
// src/entrypoints/content.ts — ISOLATED world (default): has chrome.* / messaging
export default defineContentScript({
  matches: ['*://x.com/*', '*://twitter.com/*'],
  main(ctx) {
    document.addEventListener('xmd:media-response', (e) => {
      const detail = (e as CustomEvent).detail               // untrusted page-origin data
      void browser.runtime.sendMessage({ _tag: 'CaptureResponse', ...detail })
    })
    // SPA: x.com is history-mode; re-mount overlays on route change:
    ctx.addEventListener(window, 'wxt:locationchange', () => {/* remount */})
  },
})
```

- MAIN→ISOLATED bridge: prefer a **document `CustomEvent`** (single-origin SPA,
  avoids cross-frame `postMessage` spoofing). If using `window.postMessage`
  instead, the receiver MUST guard `if (event.source !== window) return;`.
- **The spec says the MAIN tee uses `window.postMessage` and WXT `injectScript`.**
  We instead use a declarative `world:"MAIN"` content script (no WAR, no
  `injectScript`, simpler, CSP-robust) + `CustomEvent`. See §9.
- `webRequest`/`declarativeNetRequest` **cannot read response bodies** in MV3 —
  the MAIN-world patch is the only supported way to read X's GraphQL JSON. We
  need **no** `webRequest`/`scripting` permission.
- Treat all captured bodies as **untrusted input**; validate with Schema in the SW.

---

## (d) chrome.downloads — filename/subfolder constraints

```ts
const downloadId = await browser.downloads.download({
  url,                                   // required
  filename,                              // RELATIVE path under Downloads; '/' = subdirs OK
  conflictAction: 'uniquify',            // 'uniquify' | 'overwrite' | 'prompt'(no Firefox)
})
if (downloadId === undefined) {          // START error path
  const reason = browser.runtime.lastError?.message ?? 'failed'
}
```

Hard constraints the filename engine MUST enforce **before** calling `download()`:

- **Relative only**; nested subdirs via forward `/` are allowed. **Absolute paths,
  empty paths, and any `..` back-reference cause `download()` to throw.** Strip
  leading `/`, reject/strip `..`, never emit empty/absolute.
- **Progress is not in `onChanged`** (excludes `bytesReceived`/`estimatedEndTime`)
  → poll `downloads.search({id})`; guard `totalBytes === -1`.
- Two failure modes: **start** (`downloadId === undefined` + `runtime.lastError`)
  and **interruption** (`onChanged` → `delta.state.current === 'interrupted'`,
  read `delta.error.current` `InterruptReason`; map `SERVER_FORBIDDEN`/
  `NETWORK_TIMEOUT` to retry/backoff).
- **No platform concurrency limit** → the queue self-throttles to avoid 403/429
  from twimg.
- Cookies auto-attach for HTTP(S) downloads and the download is **not** subject
  to page CORS → hand the CDN URL to `download()` from the SW.
- `open()`/`setUiOptions()` need extra permissions we do NOT have — don't call them.

---

## (e) WXT — entrypoints / content-UI / messaging / storage / testing

**Import paths (WXT 0.20.26) — auto-imported, but explicit forms:**

| Symbol | Real module |
|---|---|
| `defineBackground`/`defineContentScript`/`defineUnlistedScript` | `wxt/utils/define-*` |
| `createShadowRootUi` | `wxt/utils/content-script-ui/shadow-root` |
| `injectScript` | `wxt/utils/inject-script` |
| `storage` | `wxt/utils/storage` (or `#imports`) |
| `WxtVitest` | **`wxt/testing/vitest-plugin`** (NOT the deprecated `wxt/testing`) |
| `fakeBrowser` | **`wxt/testing/fake-browser`** |

**Content overlay (style-isolated Preact in a Shadow Root):**

```ts
// src/entrypoints/overlay.content/index.tsx
import './style.css'                       // 1. Tailwind entry
import { render } from 'preact'
export default defineContentScript({
  matches: ['*://x.com/*'],
  cssInjectionMode: 'ui',                  // 2. REQUIRED for createShadowRootUi
  async main(ctx) {
    const ui = await createShadowRootUi(ctx, {        // 3. async!
      name: 'xmd-overlay', position: 'inline', anchor: 'body',
      onMount: (container) => { render(<App/>, container); return container },
      onRemove: (c) => c && render(null, c),
    })
    ui.mount()
  },
})
```

**Storage (versioned items):**

```ts
import { storage } from 'wxt/utils/storage'
const settingsItem = storage.defineItem<Settings>('local:settings', {
  fallback: defaultSettings, version: 1,   // area prefix REQUIRED: local:/session:/sync:/managed:
})
await settingsItem.getValue()
await settingsItem.removeValue()           // NOT deleteValue() — that method does not exist
const unwatch = settingsItem.watch((nv) => {/* react */})
```

**Messaging:** WXT ships **no** built-in messaging and does **not** require
`@wxt-dev/messaging`. We stay **Effect-based** over `browser.runtime.sendMessage`
/`onMessage`. For download **progress streaming** prefer a long-lived named
`runtime.connect({ name: 'queue' })` port (name-gate with `if (port.name !==
'queue') return`); keep request/response on `sendMessage`. SW→content must use
`browser.tabs.sendMessage(tabId, …)`, never `runtime.sendMessage`.

`onMessage` async-reply rule (verbatim): **return literal `true`** to keep the
channel open, then call `sendResponse` from the `Effect.runPromise` callback. Do
NOT register a bare `async` listener (it returns a Promise, not `true`, and on
Chrome <148 the channel closes). No-receiver error
(`"Could not establish connection. Receiving end does not exist."`) means
SW-asleep / CS-not-injected → treat as **retryable**, distinct from `ParseError`
(non-retryable, never invoke handler).

**Testing:**

```ts
// vitest.config.ts
import { WxtVitest } from 'wxt/testing/vitest-plugin'   // FIX: current file uses deprecated 'wxt/testing'
export default defineConfig({ plugins: [WxtVitest()], test: { environment: 'happy-dom' } })

// *.test.ts
import { fakeBrowser } from 'wxt/testing/fake-browser'
beforeEach(() => fakeBrowser.reset())
```

`fakeBrowser` ships **with WXT** — do NOT add `@webext-core/fake-browser` as a
dependency (task-001 lists it). Mock `#imports` APIs by their **real** path
(e.g. `vi.mock('wxt/utils/inject-script')`), never `'#imports'`.

---

## (f) Effect v4 — service + Layer + tagged errors + concurrency/Schedule

**There is no `Effect.Service` in v4.** Use `Context.Service` + an explicit
`Layer`. No `.Default` layer is auto-generated. (Compiled clean, exit 0.)

```ts
import { Context, Data, Effect, Layer, Schedule, Semaphore } from "effect"

// Tagged error (Effect.catchTag-able):
class DownloadError extends Data.TaggedError("DownloadError")<{
  readonly id: string; readonly reason: string
}> {}

// Service = class extends Context.Service<Self, Shape>()("Key")  — note the empty ()
class SettingsService extends Context.Service<SettingsService, {
  readonly get: Effect.Effect<{ concurrency: number }>
}>()("app/SettingsService") {}
const SettingsLive = Layer.succeed(SettingsService, { get: Effect.succeed({ concurrency: 3 }) })

class DownloadQueue extends Context.Service<DownloadQueue, {
  readonly enqueue: (ids: ReadonlyArray<string>) => Effect.Effect<void, DownloadError>
}>()("app/DownloadQueue") {}

// Dependency injection: yield other services inside Layer.effect, then Layer.provide.
const DownloadQueueLive = Layer.effect(
  DownloadQueue,
  Effect.gen(function* () {
    const settings = yield* SettingsService          // class tag is itself an Effect (yieldable)
    const sem = yield* Semaphore.make(1)             // Semaphore is its OWN module in v4
    return {
      enqueue: (ids) => Effect.gen(function* () {
        const { concurrency } = yield* settings.get
        yield* Effect.forEach(ids,
          (id) => sem.withPermits(1)(downloadOne(id)).pipe(
            Effect.retry(Schedule.exponential("100 millis", 2).pipe(Schedule.both(Schedule.recurs(3)))),
            Effect.mapError(() => new DownloadError({ id, reason: "x" })),
          ),
          { concurrency },                            // number | "unbounded" | "inherit"
        )
      }),
    }
  }),
)

const AppLive = DownloadQueueLive.pipe(Layer.provide(SettingsLive))  // hide the dep
// run:  Effect.runPromise(prog.pipe(Effect.provide(AppLive)))
// test: Layer.mock(SettingsService, { get: Effect.succeed({ concurrency: 1 }) })
//       or Effect.provideService(self, SettingsService, impl)
```

Key facts (all verified against `node_modules/effect/dist/*.d.ts`):

- `Effect.Service` → **gone**; rewrite to `Context.Service`. No `.Default`.
- `Effect.makeSemaphore`/`makeMutex` → **gone**; use `Semaphore.make(n)`
  (`Semaphore.d.ts:231`). There is **no** `mutex` export — a mutex is just
  `Semaphore.make(1)`. Guard with `sem.withPermits(n)(effect)`.
- Concurrency = the `{ concurrency }` option on `Effect.forEach`
  (`number | "unbounded" | "inherit"`), default sequential.
- Retry: `Effect.retry(self, Schedule.exponential(base, factor).pipe(
  Schedule.both(Schedule.recurs(n))))` — `recurs(n)` = n **retries** after the
  initial attempt. Options-object form `{ times, while, until, schedule }` also OK.
- Tagged error = `Data.TaggedError("Tag")<{fields}>`. Schema-encoded variant =
  `Schema.TaggedErrorClass` (note the `Class` suffix), used only across RPC.
- Service tags ARE Effects → `const s = yield* MyService` works directly;
  `Effect.service(Tag)` is the explicit accessor.
- For progress events use `PubSub` + `Stream.fromPubSub` — but remember (§b) the
  PubSub is in-SW memory and dies on recycle; popup reads progress via messaging.

---

## (g) Effect v4 Schema — struct / union / decode

`import { Schema } from "effect"` (core). PascalCase combinators; **defaults take
an `Effect`, not a thunk**; **`decodeUnknownEither` does not exist** — use
`decodeUnknownResult` + `Result`, or `decodeUnknownSync`, or
`decodeUnknownEffect`. (Compiled clean, exit 0.)

```ts
import { Schema, Result, Effect } from "effect"

const MediaType = Schema.Literals(["photo", "video", "gif"])     // Literals (array) — NEW in v4

const MediaItem = Schema.Struct({
  id: Schema.String.pipe(Schema.brand("MediaId")),               // brand narrows type only
  tweetId: Schema.String, handle: Schema.String, type: MediaType,
  url: Schema.String, ext: Schema.String, index: Schema.Number,
  width: Schema.optional(Schema.Number),                         // key absent OR undefined
  height: Schema.optional(Schema.Number),
  bitrate: Schema.optional(Schema.Number),
})
export type MediaItem = typeof MediaItem.Type                    // accessor (preferred v4 idiom)

const Settings = Schema.Struct({
  filenameTemplate: Schema.String.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("{handle}/{tweetId}_{index}.{ext}"))), // fills on decode
  downloadConcurrency: Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(3))),
  authFallbackEnabled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  theme: Schema.Literals(["light","dark","system"]).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("system" as const))),
})
export type Settings = typeof Settings.Type

// Tagged-union messages (discriminated by _tag, exhaustive switch narrows):
const DetectRequest  = Schema.TaggedStruct("DetectRequest",  { tweetId: Schema.String })
const MediaDetected  = Schema.TaggedStruct("MediaDetected",  { items: Schema.Array(MediaItem) })
const DownloadRequest= Schema.TaggedStruct("DownloadRequest",{ items: Schema.Array(MediaItem) })
const QueueUpdate    = Schema.TaggedStruct("QueueUpdate",    { completed: Schema.Number, total: Schema.Number })
const Message = Schema.Union([DetectRequest, MediaDetected, DownloadRequest, QueueUpdate]) // members = ARRAY
export type Message = typeof Message.Type

// Decode: fills decoding-defaults when keys absent.
const s = Schema.decodeUnknownSync(Settings)({})                 // throws on bad input

// Non-throwing: Result (NOT Either). SchemaError (NOT ParseError).
const r = Schema.decodeUnknownResult(Message)(raw)
if (Result.isFailure(r)) {
  const err = r.failure        // SchemaError: { _tag: "SchemaError", message, issue }
  // err.issue is a SchemaIssue tree (Composite/Pointer/InvalidType/MissingKey/…)
}
```

Schema facts:

- `Schema.Union([A,B])`, `Schema.Literals([...])`, `Schema.Tuple([...])` take
  **arrays**, not variadic args.
- Type derivation: `typeof S.Type` / `typeof S.Encoded`. Namespace helpers:
  `Schema.Schema.Type<…>` but encoded lives on **Codec**: `Schema.Codec.Encoded<…>`.
- The error is **`SchemaError`** with a `.issue` tree, not v3's `ParseError`.
- `optionalWith(..., { default })` → **does not exist** in v4. Use
  `withDecodingDefaultKey`/`withDecodingDefault` (fill on decode) and/or
  `withConstructorDefault` (fill on `.make()`). They are **different mechanisms**:
  decoding-defaults do NOT make a field omittable in `.make()`.
- `optional` = `key?: T | undefined`; `optionalKey` = exact-optional `key?: T`
  (matters under `exactOptionalPropertyTypes`, which task-001 enables).
- `_tag` must be present in the wire payload for `decode` (only `.make()`
  auto-fills it).

---

## 9. Corrections to spec/plan

Ordered by build-breaking severity.

1. **`Effect.Service` → `Context.Service` + explicit `Layer`.** (`Effect.Service`
   does not exist in 4.0.0-beta.78.) Affects: design §4; plan
   task-003-resolver-impl, task-004-xadapter-impl, task-006-settings-impl,
   task-007-download-queue-impl. There is no auto `.Default` layer — build
   `Layer.effect(Tag, gen)` / `Layer.succeed(Tag, impl)` and wire deps with
   `Layer.provide`.

2. **`Schema.decodeUnknownEither` → `decodeUnknownResult` (+`Result`) or
   `decodeUnknownSync`/`decodeUnknownEffect`.** (`*Either` removed.) Affects:
   task-002-schema-test step 1, task-002-schema-test BDD ("fails with a
   ParseError") and any reliance on `Either`. The error type is **`SchemaError`**
   (`.issue` tree), not `ParseError` — fix the schema-test and messaging wording
   (task-008-impl "reject … on `ParseError`").

3. **`Schema.optionalWith(..., { default })` → `withDecodingDefaultKey(Effect…)`**
   (or `withConstructorDefault`). (`optionalWith` removed; defaults take an
   `Effect`, not a value/thunk.) Affects: task-002-schema-impl step 2.

4. **Drop `@effect/schema` from deps.** Schema is in `effect` core in v4; the
   package is not installed and must not be added. Affects: task-001-scaffold
   step 1 (`effect @effect/schema preact` → `effect preact`).

5. **Drop `@webext-core/fake-browser` from deps.** `fakeBrowser` ships with WXT
   (`wxt/testing/fake-browser`). Affects: task-001-scaffold step 1.

6. **`vitest.config.ts`: import `WxtVitest` from `wxt/testing/vitest-plugin`**
   (current file + the plan are inconsistent — task-001 step 4 is already
   correct; the committed `vitest.config.ts` uses the deprecated `wxt/testing`
   barrel). Also import `fakeBrowser` from `wxt/testing/fake-browser`. Fix the
   committed file.

7. **DownloadQueue must not `await` downloads to completion inside one handler.**
   Design §4 / task-007 ("`Effect.forEach(items, downloadOne, { concurrency })`")
   risks the **5-min cap** and loses `Semaphore`/`PubSub` state on the **30s idle**
   termination. Redesign: `downloadOne` **fires** `chrome.downloads.download`
   (no await of file completion); progress/retry driven by a top-level
   `downloads.onChanged` listener; **persist queue state to `chrome.storage`** and
   rehydrate+reconcile (`downloads.search`) on SW restart. Add a resume step so
   the "popup queue reaches 5/5" scenario (task-012) survives an idle kill.

8. **Progress is not observable via `onChanged`.** For per-item byte progress,
   **poll `downloads.search({id})`** (guard `totalBytes === -1`). The
   `QueueUpdate` (completed/total) counts come from `onChanged` state transitions.
   Affects task-007 ("Emit progress updates") and task-011 popup.

9. **MAIN-world tee: use a declarative `world:"MAIN"` content script + document
   `CustomEvent`, not WXT `injectScript` + `window.postMessage`.** Design §3/§4
   and task-009 specify `injectScript`/`postMessage`; the declarative path needs
   **no `web_accessible_resources`**, is CSP-robust, and matches the validated
   TMH pattern. If `postMessage` is kept, the receiver MUST guard
   `event.source === window`. Set `runAt: 'document_start'` (task-009 omits it —
   default `document_idle` is too late and the tee captures nothing).

10. **Tee `XMLHttpRequest`; teeing `fetch` too is recommended hardening, not
    mandatory.** TMH's `injectFetch.ts` patches **only XHR** and works in
    production today (X's GraphQL media endpoints currently go over XHR), so
    XHR-only is a viable MVP. Teeing `fetch` as well is cheap insurance against
    X migrating endpoints to `fetch` — do both to be future-proof, but it is not
    a correctness requirement. Task-009's "wrap fetch and XHR" is fine; just
    don't treat the `fetch` patch as load-bearing.

11. **Background `main()` cannot be async, and listeners must be registered
    synchronously first.** Add this to task-012 ("Background registers message
    handlers"): register `onMessage`/`onChanged`/`onInstalled`/`onStartup`
    synchronously at the top of `defineBackground.main()`, then build the Effect
    runtime fire-and-forget. `onMessage` returns literal `true` for async replies.

12. **`MediaType` typing.** task-002-schema-impl declares
    `MediaType: Schema.Schema<"photo"|"video"|"gif">` — fine, but implement it as
    `Schema.Literals(["photo","video","gif"])` (array). Derive types with
    `typeof X.Type` (the plan's `Schema.Schema.Type<typeof X>` also compiles).

13. **SettingsService concurrency.** Read-modify-write patch-merge over
    `chrome.storage` is **not atomic**; funnel all settings writes through the
    single background SW (single-writer) and let popup/content observe via
    `storage.onChanged` / `item.watch`. Affects task-006.

14. **Auth-fallback path is subject to the 30s fetch cap + 5-min request cap.**
    Gate the single GraphQL replay (task-012 step 2) behind a timeout + retry,
    off the main awaited path. (Spec §2 already scopes it to one request, opt-in,
    default off — keep that.)

15. **CWS publish prerequisites (not in plan).** A privacy policy URL + Privacy
    Practices tab + Limited-Use certification are required **even for a local-only,
    no-telemetry** extension. Add a deployment task. Keep the generic icon / "X
    Media Downloader" name (no X marks) and the "local-only, no scraping"
    description for IP/impersonation review.
