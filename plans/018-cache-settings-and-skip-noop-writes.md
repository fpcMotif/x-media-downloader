# Plan 018: The service worker reads settings from memory, skips storage writes that change nothing, and reads relay receipts once per burst

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 7456911 -- src/packages/kernel/durable-store.ts src/packages/kernel/tests/durable-store.test.ts src/packages/settings/index.ts src/packages/settings/cache.ts src/packages/settings/tests/cache.test.ts src/packages/settings/tests/settings.test.ts src/background/remote-upload.ts src/background/remote-upload.test.ts src/entrypoints/background.ts`
> `src/entrypoints/background.ts` and `src/background/remote-upload.ts` already
> show as changed, because the working tree had uncommitted edits when this
> plan was written. `background.ts` was being edited while this plan was
> written, so its line numbers are not given; find each place by the quoted
> text. Compare every "Current state" excerpt against the live code before
> proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW–MED
- **Depends on**: none. Plan 019 depends on this plan. Plan 017 also edits `src/background/remote-upload.ts` (a different function, `reconcile`); run 017 and 018 one after the other, never in parallel.
- **Category**: perf
- **Planned at**: commit `7456911`, 2026-11-16. Excerpts were read from a working tree with uncommitted changes on top of this commit. Compare every excerpt with the live file before editing.

## Why this matters

The service worker pays three avoidable storage costs on its busiest paths.

1. **Settings.** Every `getSettings()` call reads `chrome.storage.local`,
   decodes the full settings schema, and starts an Effect runtime. The worker
   calls it once per finished download, once per download request, twice per
   upload job, and once per capture batch. Settings change only when the user
   edits them.
2. **No-op writes.** The shared read-modify-write helper writes the whole
   value back to storage even when the update function returned its input
   unchanged. Several update functions do that on purpose. One of them runs on
   every service-worker start.
3. **Relay receipts.** `owns(mediaId)` reads and decodes the whole receipts
   list for each media id. Callers ask about many ids at once with
   `Promise.all`, so one download request causes N identical reads.

After this plan: the worker holds the decoded settings in memory and re-reads
them once after each change, unchanged values are not rewritten, and a burst
of `owns` calls shares one read.

## Current state

### Part A — the read-modify-write helper

`src/packages/kernel/durable-store.ts` — the whole file:

```ts
// src/packages/kernel/durable-store.ts:1-19
import type { JsonValue } from '@/packages/schema'
import type { SerialQueue } from './serial-queue'

export interface DurableStore {
  readonly get: () => Promise<JsonValue>
  readonly set: (value: JsonValue) => Promise<void>
}

export const runSerializedRmw = <S extends JsonValue>(
  queue: SerialQueue,
  store: DurableStore,
  decode: (raw: JsonValue) => S,
  update: (state: S) => S | Promise<S>,
): Promise<S> =>
  queue.run(async () => {
    const next = await update(decode(await store.get()))
    await store.set(next)
    return next
  })
```

Its existing test file (the pattern for new tests):

```ts
// src/packages/kernel/tests/durable-store.test.ts:6-22
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const decodeStrings = (raw: JsonValue): string[] => (Array.isArray(raw) ? raw.map(String) : [])

function delayedStore(initial: JsonValue): DurableStore & { value: JsonValue } {
  const box = {
    value: initial,
    async get() {
      await tick()
      return box.value
    },
    async set(value: JsonValue) {
      await tick()
      box.value = value
    },
  }
  return box
}
```

Callers of `runSerializedRmw` (all were read while writing this plan; none
mutates its input in place, each returns either a new value or the same
reference):

- `src/background/cloud-upload.ts` — `updateLedger` (8 call sites, including
  `await updateLedger((ledger) => capLedger(ledger))` in the boot path)
- `src/background/sync-outbox.ts` — `markDrained`, `markFailed`, `append`, and
  `clearOutbox` (which uses `(raw) => raw` as decoder and `() => null` as update)
- `src/background/capture-outbox.ts` — three sites (about lines 85, 108, and
  119): claim, enqueue, and `clear`. `clear` uses `() => []` as its update. It
  returns a NEW empty array every time, which is never the same reference as
  the decoded value, so `clear` always writes, exactly as today. Skipping
  unchanged values is correct for it.
- `src/entrypoints/background.ts` — `flushReleaseDiagnostics`

### Part B — settings

`src/packages/settings/index.ts` exposes the three functions this plan wraps:

```ts
// src/packages/settings/index.ts:77-89
/** Promise helpers for UI contexts (popup) — thin wrappers over the service. */
export const getSettings = (): Promise<Settings> =>
  provide(Effect.flatMap(SettingsService, (s) => s.get)).catch((err: unknown) => {
    console.warn('[XMD] getSettings failed, falling back to defaults:', err)
    return defaults
  })
export const setSettings = (patch: Partial<Settings>): Promise<Settings> =>
  provide(Effect.flatMap(SettingsService, (s) => s.set(patch)))

/** Live subscription for long-lived contexts (content scripts), so popup changes
 *  reach already-open tabs without a reload. Returns an unwatch function. */
export const watchSettings = (cb: (s: Settings) => void): (() => void) =>
  item.watch((raw) => cb(decode(raw)))
```

Each read does a storage read plus a full decode:

```ts
// src/packages/settings/index.ts:36-38
// Single-writer (background SW): read-modify-write is non-atomic (ADR-0005).
export const SettingsServiceLive = Layer.succeed(SettingsService, {
  get: Effect.promise(() => item.getValue()).pipe(Effect.map(decode)),
```

`src/entrypoints/background.ts` imports them (near the top of the file):

```ts
import {
  SettingsService,
  SettingsServiceLive,
  getSettings,
  setSettings,
  watchSettings,
} from '@/packages/settings'
import { planConvexEnvSeed, planCloudEnvSeed } from '@/packages/settings/env-seed'
```

In `background.ts`, `getSettings` is used in these places. Find each by its
text (`rg -n "getSettings|setSettings\(" src/entrypoints/background.ts`):

| Text to find | Kind |
|---|---|
| `const settings = await getSettings()` inside `handleCloudHistoryNotice` | call |
| `getSettings,` inside `makeCloudUpload({` | passed as a dependency |
| `getSettings,` inside `makeClearSession({` | passed as a dependency |
| `const s = await getSettings()` inside `queryConvexSaved` | call |
| `getSettings,` inside `makeAdmissionGate({` | passed as a dependency |
| `const settings = await getSettings()` in the download-settle function (the one that later calls `recordHistory: (actions) => recordHistory(settings, actions)`) | call |
| `['SyncTestRequest', async () => runSyncConnectionTest(await getSettings())],` | call |
| `void getSettings().then((s) =>` before the "background booted" log | call |
| `let s = await getSettings()` in the Cloud Sync boot block | call |
| `if (p) s = await setSettings(p)` | write |
| `if (cloudPatch) s = await setSettings(cloudPatch)` | write |
| `const settings = await getSettings()` inside the `alarms.onAlarm` listener | call |
| `const captureOutbox = makeCaptureOutbox()` | constructs with the default `getSettings` |

`makeCloudUpload` already accepts an injected settings writer:

```ts
// src/background/cloud-upload.ts:194-199
  /** The settings writer (default: the core `setSettings`). Always re-serialized
   *  through the SW-side settingsQueue inside, so single-writer serialization holds.
   *
   * @see ADR-0005
   */
  readonly setSettings?: (patch: Partial<Settings>) => Promise<Settings>
```

and it re-reads settings right after it may have written a token:

```ts
// src/background/cloud-upload.ts:638-641
      try {
        const accessToken = await ensureAccessToken(settings, job.provider, now)
        settings = await getSettings() // re-read after a possible token write
        outcome = await dispatchToProvider(job, accessToken, settings)
```

This is why the cache must be updated by the worker's own writes at once, and
not only by the storage change event (which arrives later).

`getSettings` hides read failures. It returns defaults instead of rejecting
(excerpt above, `settings/index.ts:78-82`). A cache built on it would store
defaults after one failed read and serve them until the next change. So the
cache needs a read that REJECTS on failure. None is exported today; Step 3
adds one.

`background.ts` runs all its listener registration inside `defineBackground`
(search `export default defineBackground(() => {`). The settings watcher
lives there:

```ts
  watchSettings((s) => {
    if (!s.cloudSyncEnabled) syncOutbox.clearOutbox()
    // Clear the upload-failure badge when Cloud upload is switched off.
    if (!s.cloudUploadEnabled) cloudUpload.clearUploadBadge()
    // Pausing or disconnecting a provider can resolve a pending Cloud-only
    // verdict (issue #95): sweep so its Download History terminal fires without
    // waiting for the next drain.
    void cloudUpload.reconcileCloudOnlyHistory().catch(queueError('cloudReconcile'))
  })
```

The cache must not subscribe to storage at module scope. It is created at
module scope as a plain object with no browser call, and this existing
watcher tells it when to drop its value.

`makeCaptureOutbox` accepts an injected reader:

```ts
// src/background/capture-outbox.ts:41-50
export function makeCaptureOutbox(
  deps: {
    getSettings?: () => Promise<Settings>
    ...
  } = {},
): CaptureOutbox {
  const readSettings = deps.getSettings ?? getSettings
```

The download handler reads settings through the Effect service
(`const svc = yield* SettingsService` … `Effect.provide(SettingsServiceLive)`).
That path runs once per download request and is NOT changed by this plan.

### Part C — relay receipts

```ts
// src/background/remote-upload.ts:86-89
  const read = async (): Promise<ReadonlyArray<Receipt>> => {
    const raw = await store.get()
    return raw === null ? [] : Schema.decodeUnknownSync(Receipts)(raw)
  }
```

```ts
// src/background/remote-upload.ts:446 (inside the returned object)
    owns: async (mediaId) => (await read()).some((row) => row.mediaId === mediaId),
```

Callers ask in bursts:

```ts
// src/background/admission-gate.ts:40
    const ownership = await Promise.all(items.map((item) => deps.remoteOwns?.(item.id) ?? false))
```

```ts
// src/background/cloud-upload.ts:852 (backfill: up to 500 ids)
    const remoteOwned = await Promise.all(candidates.map((record) => remote.owns(record.requestId)))
```

```ts
// src/background/cloud-upload.ts:488 (every recorded upload batch)
    const owned = await Promise.all(items.map(({ item }) => remote.owns(item.id)))
```

`background.ts` has a fourth burst: `candidates.map((c) => cloudUpload.remoteOwns(c.item.id))`.

`src/background/remote-upload.test.ts` has no shared fetch double. Each test
defines its own (for example `const fetchImpl = vi.fn<typeof fetch>()` at
about line 148).

Test harness in `src/background/remote-upload.test.ts`:

```ts
// src/background/remote-upload.test.ts:36-44
function memoryStore(): DurableStore {
  let value: unknown = null
  return {
    get: async () => value,
    set: async (next) => {
      value = next
    },
  }
}
```

### Rules that apply

From `docs/adr/0005-state-persistence-split.md:15-16`: "**Settings →
`storage.local`** — durable across browser restarts (single-writer: the
background SW; popup/content observe via `storage.onChanged`)." The cache in
this plan holds a copy of the stored settings; `storage.local` stays the
source of truth and every write still goes to it.

From `docs/adr/0020-durable-drain-storage-and-sync-wake.md:19-20`: "Share one
`DurableStore` interface and `runSerializedRmw` helper. Each shell keeps its
own ledger and drain loop." Keep one shared helper; do not fork it.

From `AGENTS.md`:

- "Forbidden, without exception: `oxlint-disable` / `eslint-disable` /
  `@ts-ignore` / `@ts-expect-error`".
- "Every `as` needs an uppercase `SAFETY:` comment". Add no new `as` casts.
- `unknown` is banned in parameters, returns, and type aliases. Use the domain
  type, or `JsonValue` / `JsonObject` from `@/packages/schema`.
- "Named constants, not magic numbers."
- "`async/await` over promise chains."
- Packages under `src/packages` are imported only through their root files.
  A new root file (`src/packages/settings/cache.ts`) is a new entry point and
  may be imported from outside. Tests under `tests/` import only entry points.
  `bun run lint:boundaries` enforces this.
- Effect code is Effect v4. v3 idioms such as `Effect.Service`, `catchAll`,
  and `decodeUnknownEither` do not exist. This plan needs no new Effect code.
- Tests are vitest with assertions inside `it()`.

Comment rule: do not add, edit, or delete code comments, except a comment that
describes code this plan removes. A pre-edit hook (`doc-lock`) blocks other
comment changes. Carry intent in names, types, and tests. Do not edit any
Markdown file except this plan's status row in `plans/README.md`.

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

The package manager is bun. Never use npm or npx.

## Scope

**In scope** (the only files you should modify):

- `src/packages/kernel/durable-store.ts`
- `src/packages/kernel/tests/durable-store.test.ts`
- `src/packages/settings/index.ts` — add ONE export, `readSettings` (a read
  that rejects on failure), and make `getSettings` call it. Nothing else.
- `src/packages/settings/tests/settings.test.ts` — add one test for `readSettings`
- `src/packages/settings/cache.ts` (create)
- `src/packages/settings/tests/cache.test.ts` (create)
- `src/background/remote-upload.ts` — the `owns` entry, one new variable
  (`ownershipRead`), and one new function (`readForOwnership`) inside
  `makeRemoteUpload`
- `src/background/remote-upload.test.ts` — add one test
- `src/entrypoints/background.ts` — wiring only (the places in the table
  above, plus one line in the existing `watchSettings` callback)
- `plans/README.md` — this plan's row in the "Performance plans (012–023)"
  table only

**Out of scope** (do NOT touch, even though they look related):

- The behaviour of `getSettings`, `setSettings`, and `watchSettings` in
  `src/packages/settings/index.ts`. `getSettings` must still return defaults
  and warn on a failed read. Do NOT add a module-level cache there: the popup,
  options page, content scripts, and many tests use these functions, and tests
  reset the fake browser between cases.
- The Effect path in the download handler (`yield* SettingsService`,
  `Effect.provide(SettingsServiceLive)`).
- `src/background/admission-gate.ts`, `src/background/cloud-upload.ts`,
  `src/background/clear-session.ts`, `src/background/capture-outbox.ts` — they
  already take settings readers as dependencies. Only `background.ts` changes
  what it passes.
- The `RemoteUploadPort` interface. `owns(mediaId)` keeps its signature.
- `reconcile` in `remote-upload.ts` (plan 017 owns it).
- The history key and the upload ledger caching (plan 019 owns them).

## Git workflow

- Branch: `advisor/018-cache-settings-and-skip-noop-writes`
- Conventional commits. Example from this repo:
  `feat(relay): support Last-Modified validator, direct folder upload, and bump Convex to 1.46.0`.
  Use one commit per part: `perf(kernel): skip the storage write when a
  reducer returns its input`, `perf(settings): cache decoded settings in the
  service worker`, `perf(relay): share one receipts read across an owns burst`.
- Do NOT push or open a PR.
- The working tree has unrelated uncommitted user changes, including edits
  inside `src/entrypoints/background.ts`, `src/background/remote-upload.ts`,
  and `src/packages/settings/index.ts`. Never revert or stash them.
- Staging rule: before you start, run `git status --short` and note which
  in-scope files already show as modified. Do NOT commit those files. Leave
  your edits in them unstaged and list them in your report. Commit only
  in-scope files that were clean (or new) when you started.

## Steps

### Step 1 (Part A): Failing test for the no-op write

In `src/packages/kernel/tests/durable-store.test.ts`, add tests to the
existing `describe('runSerializedRmw', ...)` block. Use a store that counts
`set` calls (extend `delayedStore` with a `sets` counter, or write a small
`countingStore`).

1. "does not write when the reducer returns its input" —
   `await runSerializedRmw(queue, store, decodeStrings, (state) => state)`.
   Expect `set` to have been called 0 times and the returned value to equal
   the decoded state.
2. "still writes when the reducer returns a new value" —
   reducer `(state) => [...state, 'a']`. Expect `set` called 1 time and the
   stored value to equal `['a']`.
3. "does not write when a null store is cleared to null" —
   `runSerializedRmw(queue, storeHoldingNull, (raw) => raw, () => null)`.
   Expect `set` called 0 times.

**Verify**: `bun run test src/packages/kernel/tests/durable-store.test.ts`
→ tests 1 and 3 FAIL (1 write each); test 2 and the existing test pass.

### Step 2 (Part A): Skip the write

In `src/packages/kernel/durable-store.ts`, change the queued task to:

```ts
  queue.run(async () => {
    const current = decode(await store.get())
    const next = await update(current)
    if (next !== current) await store.set(next)
    return next
  })
```

Change nothing else in the file.

**Verify**: `bun run test src/packages/kernel/tests/durable-store.test.ts` → all pass.
**Verify**: `bun run test src/background/cloud-upload.test.ts`,
`bun run test src/background/sync-outbox.test.ts`, and
`bun run test src/background/capture-outbox.test.ts` → all pass.

### Step 3 (Part B): Settings cache module with tests

#### 3a. Export a read that rejects on failure

In `src/packages/settings/index.ts`, add `readSettings` and make `getSettings`
call it. Insert `readSettings` ABOVE the existing one-line `/** Promise helpers
for UI contexts ... */` comment, so that comment stays directly above
`getSettings`, untouched. Add no comment to `readSettings`. Target code:

```ts
export const readSettings = (): Promise<Settings> =>
  provide(Effect.flatMap(SettingsService, (s) => s.get))

export const getSettings = (): Promise<Settings> =>
  readSettings().catch((err: unknown) => {
    console.warn('[XMD] getSettings failed, falling back to defaults:', err)
    return defaults
  })
```

Keep the `.catch((err: unknown) => { ... })` body exactly as it is in the live
file; only its receiver changes from the inline `provide(...)` expression to
`readSettings()`. `getSettings` behaves exactly as before.

In `src/packages/settings/tests/settings.test.ts`, add one test inside the
existing `describe('SettingsService', ...)` block:
"readSettings rejects when the storage read fails, and getSettings still
returns defaults". Make the read fail with
`vi.spyOn(fakeBrowser.storage.local, 'get').mockRejectedValue(new Error('storage down'))`
(the file already imports `vi` and `fakeBrowser`, and its `beforeEach` calls
`vi.restoreAllMocks()`). Expect `await expect(readSettings()).rejects.toThrow()`
and `(await getSettings()).downloadConcurrency` to equal the default
(`Schema`-decoded `{}` value; compare with a second `getSettings()` result
taken before the spy is installed).

**Verify**: `bun run test src/packages/settings/tests/settings.test.ts` → all
pass, including the new test. If the spy does not make `readSettings` reject
(the storage wrapper may read through a different method), see "STOP
conditions".

#### 3b. The cache module

Create `src/packages/settings/cache.ts`:

```ts
import type { Settings } from '@/packages/schema'

export interface SettingsCacheDeps {
  readonly read: () => Promise<Settings>
  readonly fallback: () => Promise<Settings>
  readonly write: (patch: Partial<Settings>) => Promise<Settings>
}

export interface SettingsCache {
  readonly get: () => Promise<Settings>
  readonly set: (patch: Partial<Settings>) => Promise<Settings>
  readonly invalidate: () => void
}

export function makeSettingsCache(deps: SettingsCacheDeps): SettingsCache
```

Contract of the three dependencies (write no comments for it; the tests carry
it): `read` must REJECT when the storage read fails. `fallback` answers one
`get` when `read` rejects, and its result is never cached. `write` applies a
patch and resolves to the full settings it stored.

`makeSettingsCache` makes NO browser call and subscribes to nothing. The
caller tells it about changes through `invalidate()`.

Required behaviour:

- State: `current: Settings | null`, `loading: Promise<Settings> | null`, and
  a counter `generation` that starts at 0.
- `get()`: return `current` when it is not `null`, without calling `read`.
  Otherwise share one pending read between concurrent callers.
- A read remembers the `generation` it started at. When it resolves, it stores
  its result in `current` ONLY IF `generation` is unchanged and `current` is
  still `null`. It always returns `current` when that is not `null`, else its
  own result. Clear `loading` when the read settles, but only if `loading` is
  still that same read.
- If `read` rejects: do not cache anything. Return `await deps.fallback()` to
  the callers of that `get`. The next `get` calls `read` again.
- `set(patch)`: `const written = await deps.write(patch)`; then
  `generation += 1`, `current = written`, and return `written`. If `write`
  rejects, change nothing and let the rejection propagate.
- `invalidate()`: `generation += 1`, `current = null`, `loading = null`. It
  takes no argument. The value carried by a storage change event is never
  applied, because events can arrive late and out of order relative to the
  worker's own writes. The next `get` re-reads storage, which always holds the
  newest value.

Create `src/packages/settings/tests/cache.test.ts`. Do not use the fake
browser; inject plain fakes. Build a base settings value the way other tests
do: `Schema.decodeUnknownSync(Settings)({})` with `Settings` imported from
`@/packages/schema` (see `src/background/admission-gate.test.ts:8-12`).
Import the unit under test through the entry point: `from '../cache'`.

Use a tiny fake storage so `read` and `write` agree:
`let stored = base`; `read = vi.fn(async () => stored)`;
`write = vi.fn(async (patch) => { stored = { ...stored, ...patch }; return stored })`;
`fallback = vi.fn(async () => base)`. Name three distinct values by a field
that is easy to compare, for example `downloadConcurrency: 1`, `2`, `3`.

Tests:

1. "reads storage once for repeated gets" — three sequential `get()` calls →
   `read` called 1 time.
2. "shares one read between concurrent first gets" —
   `await Promise.all([cache.get(), cache.get()])` → `read` called 1 time.
3. "re-reads once after an external change" — `await cache.get()`; set
   `stored` to a changed value directly (another context wrote it);
   `cache.invalidate()`; two more `get()` calls → both return the changed
   value and `read` has been called 2 times in total.
4. "serves its own write immediately" — `await cache.get()`;
   `await cache.set({ downloadConcurrency: 2 })`; the next `get()` returns the
   value with `2`, and `read` is still called 1 time.
5. "a late change event never reverts a newer own write" —
   `await cache.set({ downloadConcurrency: 2 })` (A), then
   `await cache.set({ downloadConcurrency: 3 })` (B), then `cache.invalidate()`
   (the late event for A arrives). `get()` returns the value with `3`.
6. "a read that started before a change is not cached" — `read` returns a
   promise you resolve by hand; start `get()`; call `cache.invalidate()`;
   resolve the first read; then `await cache.get()` again → `read` called 2
   times in total.
7. "a read that started before an own write does not overwrite it" — start a
   hand-resolved `get()`; `await cache.set({ downloadConcurrency: 2 })`;
   resolve the old read with the base value; a later `get()` returns the value
   with `2` and calls `read` no further time.
8. "keeps the old value when a write fails" — after one `get()`, make `write`
   reject; `await expect(cache.set(patch)).rejects.toThrow()`; `get()` still
   returns the previous value and `read` is still called 1 time.
9. "a failed read is answered by the fallback and is not cached" — `read`
   rejects on its first call and resolves afterwards; the first `get()`
   returns the `fallback` value and `fallback` was called 1 time; the second
   `get()` returns the stored value; `read` has been called 2 times.

**Verify**: `bun run test src/packages/settings/tests/cache.test.ts` → 9 passed.
(Before the module exists, the file fails to import; that is the red state.)
**Verify**: `bun run lint:boundaries` → exit 0.

### Step 4 (Part B): Wire the cache into the service worker

In `src/entrypoints/background.ts`:

1. Add the import next to the existing settings imports:
   `import { makeSettingsCache } from '@/packages/settings/cache'`.
   Add `readSettings` to the existing import list from `@/packages/settings`.
   Keep `getSettings`, `setSettings`, and `watchSettings` in that list.
2. Directly above the line that starts `const metricsItem = storage.defineItem`,
   add:

   ```ts
   const settingsCache = makeSettingsCache({
     read: readSettings,
     fallback: getSettings,
     write: setSettings,
   })
   ```

   This runs at module scope and makes no browser call. Do NOT call
   `watchSettings` here.
3. Replace every use listed in the "Current state" table:
   - each call `getSettings()` → `settingsCache.get()`
   - each dependency line `getSettings,` inside `makeCloudUpload({`,
     `makeClearSession({`, and `makeAdmissionGate({` →
     `getSettings: settingsCache.get,`
   - each `setSettings(p)` / `setSettings(cloudPatch)` → `settingsCache.set(p)` /
     `settingsCache.set(cloudPatch)`
   - inside `makeCloudUpload({ ... })`, add the line
     `setSettings: settingsCache.set,`
   - `makeCaptureOutbox()` → `makeCaptureOutbox({ getSettings: settingsCache.get })`
   - do NOT touch the line `  getSettings,` inside the `import { ... } from
     '@/packages/settings'` list. It must stay.
4. Inside `defineBackground`'s function, in the existing
   `watchSettings((s) => { ... })` callback (excerpt in "Current state"), add
   `settingsCache.invalidate()` as the FIRST statement of the callback, above
   `if (!s.cloudSyncEnabled) syncOutbox.clearOutbox()`. Change nothing else in
   that callback. It must come first: the callback's last line starts a sweep
   that reads settings through the cache.
5. Leave `SettingsService` / `SettingsServiceLive` usage exactly as it is.

**Verify**: `rg -n "await getSettings\(\)|getSettings\(\)\.then|await setSettings\(|makeCaptureOutbox\(\)" src/entrypoints/background.ts`
→ no matches.
**Verify**: `rg -c "^\s*getSettings,$" src/entrypoints/background.ts` → `1`
(only the import line is left in that form).
**Verify**: `rg -c "getSettings: settingsCache\.get" src/entrypoints/background.ts`
→ `4` (`makeCloudUpload`, `makeClearSession`, `makeAdmissionGate`,
`makeCaptureOutbox`).
**Verify**: `rg -n "settingsCache\.invalidate\(\)" src/entrypoints/background.ts`
→ exactly 1 match, on the line directly below `watchSettings((s) => {`.
**Verify**: `rg -c "watchSettings\(" src/entrypoints/background.ts` → `1`
(no second subscription was added).
**Verify**: `bun run typecheck` → exit 0.

### Step 5 (Part C): Share one receipts read across a burst

In `src/background/remote-upload.test.ts`, add a test:
"reads the receipts once for a burst of ownership checks".

1. Build a store whose `get` is a `vi.fn` wrapping `memoryStore()`'s `get`,
   seeded (via `set`) with one receipt for `'m1'`. A receipt needs these
   fields: `mediaId`, `deviceId`, `deploymentUrl`, `sourceUrl`, `path`,
   `contentType`, `accepted`.
2. Define a local fetch double inside the test:
   `const fetchImpl = vi.fn<typeof fetch>()`. The file has no shared one, and
   `owns` makes no network call, so it needs no reply. Then
   `const remote = makeRemoteUpload({ getSettings: async () => settings, fetchImpl, store, onHistoryNotice: () => {} })`.
3. `const owned = await Promise.all([remote.owns('m1'), remote.owns('m2'), remote.owns('m3')])`.
4. Expect `owned` to equal `[true, false, false]`.
5. Expect the store's `get` to have been called 1 time.
6. Then `await remote.owns('m1')` again and expect `get` called 2 times in
   total (a later call reads fresh data).

**Verify**: `bun run test src/background/remote-upload.test.ts` → the new test
FAILS at step 5 (3 calls).

Then in `src/background/remote-upload.ts`, inside `makeRemoteUpload`:

1. Next to `const queue = makeSerialQueue(() => {})`, add
   `let ownershipRead: Promise<ReadonlyArray<Receipt>> | null = null`.
2. Add a helper below `read`:

   ```ts
   const readForOwnership = (): Promise<ReadonlyArray<Receipt>> => {
     if (ownershipRead !== null) return ownershipRead
     const pending = (async () => {
       try {
         return await read()
       } finally {
         ownershipRead = null
       }
     })()
     ownershipRead = pending
     return pending
   }
   ```

3. Change the `owns` entry in the returned object to:
   `owns: async (mediaId) => (await readForOwnership()).some((row) => row.mediaId === mediaId),`

Do not change `read`, `patchReceipt`, `summary`, `budget`, or any other user
of `read()`.

**Verify**: `bun run test src/background/remote-upload.test.ts` → all pass.

### Step 6: Run the gates

**Verify**: `bun run lint` → exit 0.
**Verify**: `bun run fmt:check` → exit 0.
**Verify**: `bun run check` → exit 0.
**Verify**: `bun run build` → exit 0.

## Test plan

- `src/packages/kernel/tests/durable-store.test.ts`: three new tests (Step 1).
  "does not write when the reducer returns its input" fails before Step 2 and
  passes after. The expectation (`set` called 0 times) comes from the
  requirement "an unchanged value is not rewritten".
- `src/packages/settings/tests/settings.test.ts`: one new test (Step 3a),
  "readSettings rejects when the storage read fails, and getSettings still
  returns defaults".
- `src/packages/settings/tests/cache.test.ts`: nine new tests (Step 3b). Test
  4 encodes the requirement behind `cloud-upload.ts`'s "re-read after a
  possible token write". Test 5 encodes "a late storage event never reverts
  the cache". Tests 6 and 7 encode "a newer value never loses to an older
  read". Test 9 encodes "a failed read is never cached".
- `src/background/remote-upload.test.ts`: one new test (Step 5); fails before
  with 3 reads, passes after with 1.
- Patterns: `src/packages/kernel/tests/durable-store.test.ts` (store fakes),
  `src/background/admission-gate.test.ts:1-12` (settings fixture).
- Verification: `bun run check` exits 0.

## Done criteria

ALL must hold:

- [ ] `bun run test src/packages/kernel/tests/durable-store.test.ts` exits 0 with 4 tests
- [ ] `bun run test src/packages/settings/tests/cache.test.ts` exits 0 with 9 tests
- [ ] `bun run test src/packages/settings/tests/settings.test.ts` exits 0, including the `readSettings` test
- [ ] `bun run test src/background/remote-upload.test.ts` exits 0
- [ ] `rg -n "await getSettings\(\)|await setSettings\(|makeCaptureOutbox\(\)" src/entrypoints/background.ts` returns no matches
- [ ] `rg -c "^\s*getSettings,$" src/entrypoints/background.ts` prints `1` and `rg -c "watchSettings\(" src/entrypoints/background.ts` prints `1`
- [ ] `rg -n "settingsCache\.invalidate\(\)" src/entrypoints/background.ts` returns exactly 1 match
- [ ] `rg -n "browser\.|storage\.|watch" src/packages/settings/cache.ts` returns no matches (the cache makes no browser call)
- [ ] Your only change to `src/packages/settings/index.ts` is the new `readSettings` export and `getSettings` calling it
- [ ] `bun run check` exits 0 and `bun run build` exits 0
- [ ] `git status --short` shows no newly modified files outside the in-scope list and `plans/README.md`
- [ ] `plans/README.md` status row for 018 updated

## STOP conditions

Stop and report back (do not improvise) if:

- Any existing test asserts that a store's `set` is called for an update that
  returns its input, and fails after Step 2. Report the test name; do not
  weaken the test and do not revert the helper silently.
- An update function passed to `runSerializedRmw` is found to change its input
  object in place and return it. Skipping the write would then lose data.
  (None did when this plan was written.)
- `background.ts` uses `getSettings` or `setSettings` in a place not listed in
  the table, and you cannot tell whether it runs in the service worker.
- In Step 3a, spying on `fakeBrowser.storage.local.get` does not make
  `readSettings` reject. Report what the storage wrapper calls instead; do not
  weaken the test to "does not throw".
- `makeSettingsCache(...)` at module scope would need a browser call to work,
  or `bun run build` fails with an error that mentions `settingsCache` at
  module load. The design requires the cache to be a plain object until the
  `watchSettings` callback inside `defineBackground` calls `invalidate()`.
- The existing `watchSettings((s) => { ... })` callback inside
  `defineBackground` is missing or has moved to module scope.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- New service-worker code must read settings through `settingsCache.get` and
  write through `settingsCache.set`. A direct `setSettings` call in the worker
  still works, but the cache then learns of it only through the storage change
  event, a moment later.
- Every storage change event calls `settingsCache.invalidate()`. The cache
  drops its value and the next `get` re-reads storage once. The event's own
  value is never applied, so a late event cannot revert a newer write.
- A write through `settingsCache.set` also fires a change event. That costs
  one extra storage read after each own write. Own writes are rare (token
  refresh, options saves), so this is accepted.
- A write from another context (the options page or popup) reaches the cache
  through the same event. Between the storage write and the event the worker
  can read the previous value. This window is a few milliseconds and existed
  in a weaker form before (each read raced the write).
- A failed storage read is not cached. `get` returns `fallback()` (defaults,
  through `getSettings`) for that call and the next `get` reads storage again.
- The download handler still reads settings through the Effect
  `SettingsService` once per request. Converting it is a possible follow-up.
- Plan 019 builds on the no-op write skip: its cached store returns the same
  reference it was given, so unchanged reducers stay free.
- A reviewer should check that the diff to `background.ts` is mechanical
  (reader and writer swaps, the cache construction, and one `invalidate()`
  line) and that `src/packages/settings/index.ts` gains only `readSettings`.
