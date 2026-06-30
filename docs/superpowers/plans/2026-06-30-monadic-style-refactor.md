# Monadic-Style Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the codebase's existing Effect adoption — replace escaping raw `throw`s with `Data.TaggedError`, dedupe the backend auth guard, and pilot lifting one nullable resolver to `Option` — without rewriting control flow.

**Architecture:** The code is already functional-core / imperative-shell on `effect`. This plan adds typed errors next to the existing `DownloadError`/`DetectError`, migrates `OAuthError` from `extends Error` to `Data.TaggedError` while keeping its `.message` byte-stable (a downstream regex classifier depends on it), consolidates the duplicated Convex `assertSecret`, and converts `convexOriginPattern` to `Option` as the house-style pilot for the broader Phase 4 layer.

**Tech stack:** TypeScript 6 (tsgo), `effect@4.0.0-beta`, WXT + Preact, Convex backend, Vitest, oxlint/oxfmt, `@effect/language-service`.

**Source spec:** `docs/superpowers/specs/2026-06-30-monadic-style-refactor-design.md`. Decisions §2 are locked there.

---

## Scope of this plan

This plan delivers **Phases 0–3** (the error-typing core) in full, plus a **Phase 4 pilot** (one `Option` conversion that establishes the house pattern and proves `effect:check` is happy). The remainder of Phase 4 (the full resolve/parse `Option` layer) and the optional Phases 5–6 ripple across many caller sites and get their own plan once the pilot lands — see "Follow-up plans" at the end.

Each task is independently shippable with the full gate green.

## Gate commands (used throughout)

- Single frontend test file: `bunx vitest run <path>`
- Single test by name: `bunx vitest run <path> -t "<name>"`
- Backend test file: `cd backend && bunx vitest run <path>` (then `cd ..`)
- Effect diagnostics: `bun run effect:check`
- Full gate (run before each commit): `bun run check` (oxfmt · oxlint · `wxt prepare` · `tsgo --noEmit` · vitest) and, for backend changes, `bun run test:backend`

## File structure

| File | Change | Responsibility |
|---|---|---|
| `src/core/errors/index.ts` | modify | Central tagged errors; add `Aria2RpcError`, `OffscreenSaveError` next to `DownloadError`/`DetectError` |
| `src/core/errors/index.test.ts` | create | Asserts each tagged error's `_tag`, `.message`, `errorReason` interop |
| `src/core/cloud/oauth.ts` | modify | `OAuthError` → `Data.TaggedError`; 8 throw sites carry `{message, context}` |
| `src/core/cloud/oauth.test.ts` | modify | Update direct constructions; add message-stability assertions |
| `src/core/cloud/status.test.ts` | modify | Regression: each OAuth message still maps via `classifyUploadError` |
| `backend/convex/auth.ts` | create | Single fail-closed `assertSecret` (no `effect` dep) |
| `backend/convex/sync.ts` | modify | Import shared `assertSecret`; delete local copy |
| `backend/convex/uploads.ts` | modify | Import shared `assertSecret`; delete local copy |
| `backend/convex/sync.test.ts` | modify | Add fail-closed rejection tests |
| `backend/convex/uploads.test.ts` | modify | Add fail-closed rejection tests |
| `src/core/download/aria2.ts` | modify | Port throws → `Aria2RpcError`; strategy catch preserves message |
| `src/core/download/aria2.test.ts` | modify | Assert `Aria2RpcError` on RPC error + malformed response |
| `src/core/download/fetched-strategy.ts` | modify | Offscreen save throw → `OffscreenSaveError` |
| `src/core/download/fetched-strategy.test.ts` | modify | Assert `OffscreenSaveError` on missing `downloadId` |
| `src/core/sync/convex.ts` | modify | `convexOriginPattern` → `Option<string>` (Phase 4 pilot) |
| `src/core/sync/convex.test.ts` | modify | Update to `Option.some`/`Option.none` |
| `src/background/sync-outbox.ts` | modify | Caller of `convexOriginPattern` → `Option.isNone`/`.value` |

---

## Task 1 (Phase 0): Central tagged errors

**Files:**
- Modify: `src/core/errors/index.ts`
- Test: `src/core/errors/index.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/core/errors/index.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { Aria2RpcError, OffscreenSaveError } from './index'
import { errorReason } from '../error'

describe('tagged errors', () => {
  it('Aria2RpcError carries tag, message, optional code, and is an Error', () => {
    const e = new Aria2RpcError({ message: 'boom', code: 1 })
    expect(e._tag).toBe('Aria2RpcError')
    expect(e.message).toBe('boom')
    expect(e.code).toBe(1)
    expect(e).toBeInstanceOf(Error)
    expect(errorReason(e)).toBe('boom')
  })

  it('OffscreenSaveError carries tag and message', () => {
    const e = new OffscreenSaveError({ message: 'no document' })
    expect(e._tag).toBe('OffscreenSaveError')
    expect(errorReason(e)).toBe('no document')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/core/errors/index.test.ts`
Expected: FAIL — `Aria2RpcError`/`OffscreenSaveError` are not exported.

- [ ] **Step 3: Add the tagged errors**

In `src/core/errors/index.ts`, after the existing `DetectError` class, append:

```ts
/** An aria2 JSON-RPC call returned an error envelope or a malformed response. */
export class Aria2RpcError extends Data.TaggedError('Aria2RpcError')<{
  readonly message: string
  readonly code?: number
}> {}

/** The offscreen document failed to save a downloaded blob. */
export class OffscreenSaveError extends Data.TaggedError('OffscreenSaveError')<{
  readonly message: string
}> {}
```

(`Data` is already imported at the top of the file.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/core/errors/index.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/errors/index.ts src/core/errors/index.test.ts
git commit -m "feat(errors): add Aria2RpcError and OffscreenSaveError tagged errors

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2 (Phase 1): Migrate `OAuthError` to `Data.TaggedError`

The load-bearing constraint: `classifyUploadError` (`src/core/cloud/status.ts:35`) matches the error **message string** by regex (`/no refresh_token/i`, `/HTTP 401/`, …), reached via `errorReason(err).message`. The migrated error MUST keep the same `.message` text — `Data.TaggedError` populates `Error.message` from a `message` field, so we name the carried field `message`.

**Files:**
- Modify: `src/core/cloud/oauth.ts`
- Test: `src/core/cloud/oauth.test.ts`, `src/core/cloud/status.test.ts`

- [ ] **Step 1: Write the failing regression test (message stability)**

Append to `src/core/cloud/status.test.ts`:

```ts
import { OAuthError } from './oauth'
import { errorReason } from '../error'

describe('OAuthError message survives classification', () => {
  it('no refresh_token maps to the reconnect line', () => {
    const e = new OAuthError({
      message: 'no refresh_token — reconnect and grant offline access',
      context: 'no-offline-grant',
    })
    expect(classifyUploadError(errorReason(e))).toBe('Authorization expired — reconnect the provider.')
  })
})
```

If `classifyUploadError` is not already imported in that file, add it to the existing import from `./status`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/core/cloud/status.test.ts -t "no refresh_token"`
Expected: FAIL — `OAuthError` constructor still takes a string, not `{message, context}`.

- [ ] **Step 3: Change the `OAuthError` definition**

In `src/core/cloud/oauth.ts`, add `Data` to the effect import at the top:

```ts
import { Data } from 'effect'
```

Replace the existing class:

```ts
export class OAuthError extends Error {
  readonly _tag = 'OAuthError'
  constructor(reason: string) {
    super(reason)
    this.name = 'OAuthError'
  }
}
```

with:

```ts
export class OAuthError extends Data.TaggedError('OAuthError')<{
  readonly message: string
  readonly context?:
    | 'malformed-url'
    | 'consent-failed'
    | 'state-mismatch'
    | 'no-code'
    | 'no-token'
    | 'non-json'
    | 'token-endpoint'
    | 'no-offline-grant'
}> {}
```

- [ ] **Step 4: Update the 8 throw sites**

In the same file, replace each `throw new OAuthError('…')` with the object form:

```ts
// parseAuthRedirect
throw new OAuthError({ message: 'malformed redirect url', context: 'malformed-url' })
throw new OAuthError({ message: `consent failed: ${err}`, context: 'consent-failed' })
throw new OAuthError({ message: 'state mismatch (possible CSRF)', context: 'state-mismatch' })
throw new OAuthError({ message: 'no authorization code in redirect', context: 'no-code' })

// requireAccessToken
throw new OAuthError({ message: `${ctx} had no access_token`, context: 'no-token' })

// postToken
throw new OAuthError({ message: `token endpoint returned non-JSON (HTTP ${res.status})`, context: 'non-json' })
throw new OAuthError({
  message: json.error_description ?? json.error ?? `token endpoint HTTP ${res.status}`,
  context: 'token-endpoint',
})

// exchangeCode
throw new OAuthError({
  message: 'no refresh_token — reconnect and grant offline access',
  context: 'no-offline-grant',
})
```

- [ ] **Step 5: Update existing `oauth.test.ts` construction/assertion sites**

In `src/core/cloud/oauth.test.ts`, replace any direct `new OAuthError('x')` with `new OAuthError({ message: 'x' })`. Assertions of the form `expect(() => …).toThrow(OAuthError)` and `expect(err.message).toBe('…')` remain valid unchanged (`.message` is preserved). To make message stability explicit, add:

```ts
it('parseAuthRedirect throws OAuthError with a stable message', () => {
  expect(() => parseAuthRedirect('https://x.chromiumapp.org/?error=access_denied', 's')).toThrow(
    OAuthError,
  )
  try {
    parseAuthRedirect('not a url', 's')
  } catch (e) {
    expect((e as OAuthError).message).toBe('malformed redirect url')
    expect((e as OAuthError)._tag).toBe('OAuthError')
  }
})
```

- [ ] **Step 6: Run the affected tests**

Run: `bunx vitest run src/core/cloud/oauth.test.ts src/core/cloud/status.test.ts`
Expected: PASS

- [ ] **Step 7: Effect diagnostics + full gate**

Run: `bun run effect:check` then `bun run check`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/core/cloud/oauth.ts src/core/cloud/oauth.test.ts src/core/cloud/status.test.ts
git commit -m "refactor(cloud): OAuthError as Data.TaggedError, message-stable

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3 (Phase 2): Dedupe backend `assertSecret`

The Convex backend (`backend/package.json`) depends only on `convex` — no `effect`. Keep the throw a plain `Error` with byte-stable messages (the client classifies sync failures by message); this task is a DRY consolidation. (Optional future: switch to `ConvexError({ tag: 'Unauthorized', reason })` only after verifying the client's error envelope is unchanged — spec §8.3.)

**Files:**
- Create: `backend/convex/auth.ts`
- Modify: `backend/convex/sync.ts`, `backend/convex/uploads.ts`
- Test: `backend/convex/sync.test.ts`, `backend/convex/uploads.test.ts`

- [ ] **Step 1: Write the failing rejection tests**

Append to `backend/convex/sync.test.ts`:

```ts
describe('sync:recordEvents fails closed', () => {
  it('rejects a bad secret', async () => {
    const t = convexTest(schema, modules)
    await expect(
      t.mutation(api.sync.recordEvents, { events: [evt()], secret: 'wrong' }),
    ).rejects.toThrow('bad or missing sync secret')
  })

  it('rejects when no secret is configured', async () => {
    vi.stubEnv('SYNC_SHARED_SECRET', '')
    const t = convexTest(schema, modules)
    await expect(
      t.mutation(api.sync.recordEvents, { events: [evt()], secret: 'anything' }),
    ).rejects.toThrow('no SYNC_SHARED_SECRET configured')
  })
})
```

Append the parallel pair to `backend/convex/uploads.test.ts` (use that file's existing `job`/fixture helper and `api.uploads.recordUploadJobs`; if it has no fixture helper, inline `{ jobs: [], secret: 'wrong' }` — an empty batch still hits `assertSecret` first).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && bunx vitest run convex/sync.test.ts convex/uploads.test.ts && cd ..`
Expected: the new tests FAIL only if behavior differs; since current inline `assertSecret` already throws these messages, they should PASS already. That is intended — these tests lock the messages BEFORE the refactor so the dedupe is provably behavior-preserving. If they already pass, proceed (this is a characterization test).

- [ ] **Step 3: Create the shared helper**

Create `backend/convex/auth.ts`:

```ts
/**
 * Fail-closed shared-secret authorization (ADR-0009 hardening), shared by sync.ts
 * and uploads.ts. The deployment MUST set `SYNC_SHARED_SECRET` and the caller MUST
 * present a matching `secret`. The message strings are load-bearing — the client
 * classifies sync failures by message (src/core/sync/status.ts), so keep them stable.
 */
export function assertSecret(secret: string): void {
  const required = process.env.SYNC_SHARED_SECRET
  if (required === undefined || required === '') {
    throw new Error('unauthorized: deployment has no SYNC_SHARED_SECRET configured')
  }
  if (secret !== required) {
    throw new Error('unauthorized: bad or missing sync secret')
  }
}
```

- [ ] **Step 4: Remove the local copies and import the shared one**

In `backend/convex/sync.ts`: delete the local `assertSecret` function (the doc comment + function, currently lines 33–45) and add to the imports near the top:

```ts
import { assertSecret } from './auth'
```

In `backend/convex/uploads.ts`: delete the local `assertSecret` (currently lines 41–54) and add the same import.

- [ ] **Step 5: Run tests to verify they still pass**

Run: `cd backend && bunx vitest run convex/sync.test.ts convex/uploads.test.ts && cd ..`
Expected: PASS (behavior unchanged; messages identical).

- [ ] **Step 6: Backend typecheck + full backend tests**

Run: `cd backend && bunx tsc --noEmit && cd .. && bun run test:backend`
Expected: clean / PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/convex/auth.ts backend/convex/sync.ts backend/convex/uploads.ts backend/convex/sync.test.ts backend/convex/uploads.test.ts
git commit -m "refactor(backend): share one fail-closed assertSecret

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4 (Phase 3): aria2 + offscreen throws → tagged errors

The aria2 port throws are caught by `makeAria2Strategy`'s `Effect.tryPromise` and collapsed into `DownloadError.reason` via `String(cause)`. Converting the throws AND switching the catch to `errorReason(cause)` makes the typed message survive cleanly (drops the `"Error: "` prefix `String()` adds). Same shape for the offscreen save throw.

**Files:**
- Modify: `src/core/download/aria2.ts`, `src/core/download/fetched-strategy.ts`
- Test: `src/core/download/aria2.test.ts`, `src/core/download/fetched-strategy.test.ts`

- [ ] **Step 1: Write the failing aria2 test**

Append to `src/core/download/aria2.test.ts` (it already imports from `./aria2`; add `makeAria2RpcPort` to that import and `Aria2RpcError` from `../errors`):

```ts
describe('makeAria2RpcPort error mapping', () => {
  const port = (body: unknown) =>
    makeAria2RpcPort({
      rpcUrl: 'http://localhost:6800/jsonrpc',
      secret: '',
      fetchImpl: (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch,
    })

  it('throws Aria2RpcError with code on an error envelope', async () => {
    await expect(port({ error: { code: 1, message: 'bad uri' } }).addUri(['u'], {})).rejects.toMatchObject(
      { _tag: 'Aria2RpcError', message: 'bad uri', code: 1 },
    )
  })

  it('throws Aria2RpcError on a malformed response', async () => {
    await expect(port({ result: 42 }).addUri(['u'], {})).rejects.toMatchObject({
      _tag: 'Aria2RpcError',
      message: 'aria2: malformed JSON-RPC response',
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/core/download/aria2.test.ts -t "error mapping"`
Expected: FAIL — current throws are `new Error(...)`, no `_tag`.

- [ ] **Step 3: Convert the aria2 throws and preserve the message at the catch**

In `src/core/download/aria2.ts`:

Update imports:

```ts
import { DownloadError, Aria2RpcError } from '../errors'
import { errorReason } from '../error'
```

Replace lines 96–97:

```ts
      if (body.error)
        throw new Aria2RpcError({
          message: body.error.message ?? `aria2 error ${body.error.code ?? '?'}`,
          ...(body.error.code !== undefined ? { code: body.error.code } : {}),
        })
      if (typeof body.result !== 'string')
        throw new Aria2RpcError({ message: 'aria2: malformed JSON-RPC response' })
```

In `makeAria2Strategy`, change the catch to preserve the message:

```ts
        catch: (cause) => new DownloadError({ id: req.id, reason: errorReason(cause) }),
```

- [ ] **Step 4: Run the aria2 tests**

Run: `bunx vitest run src/core/download/aria2.test.ts`
Expected: PASS (existing strategy tests still green — `DownloadError.reason` now equals the message).

- [ ] **Step 5: Write the failing offscreen test**

In `src/core/download/fetched-strategy.test.ts`, add a test that drives the offscreen port's `saveBlob` with a response lacking `downloadId` and asserts `OffscreenSaveError`. Use the file's existing harness for building the port/`browser` mock; the assertion is:

```ts
await expect(/* saveBlob call with { error: 'disk full' } */).rejects.toMatchObject({
  _tag: 'OffscreenSaveError',
  message: 'disk full',
})
```

(If the offscreen port isn't directly exported, assert via the strategy path the file already exercises, expecting the resulting `DownloadError.reason` to be `'disk full'`.)

- [ ] **Step 6: Convert the offscreen throw**

In `src/core/download/fetched-strategy.ts`, add `OffscreenSaveError` to the `../errors` import, then replace line 254:

```ts
        throw new OffscreenSaveError({ message: res.error ?? 'offscreen save failed' })
```

Verify the `Effect.tryPromise` that wraps `saveBlob` maps via `errorReason(cause)` (mirror the aria2 catch). If it currently uses `String(cause)`, switch it to `errorReason(cause)` so the message survives.

- [ ] **Step 7: Run the download tests + full gate**

Run: `bunx vitest run src/core/download/ && bun run effect:check`
Expected: PASS / clean. Then `bun run check`.

- [ ] **Step 8: Commit**

```bash
git add src/core/download/aria2.ts src/core/download/aria2.test.ts src/core/download/fetched-strategy.ts src/core/download/fetched-strategy.test.ts
git commit -m "refactor(download): tag aria2 + offscreen errors, preserve reason

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5 (Phase 4 pilot): `convexOriginPattern` → `Option<string>`

The cleanest single `Option` conversion (one production caller). It establishes the house pattern for the rest of Phase 4 and confirms `effect:check` accepts `Option` returns + `Option.isNone`/`.value` at call sites. House precedent for `Option`: `src/core/clear/worklist.ts`.

**Files:**
- Modify: `src/core/sync/convex.ts`, `src/background/sync-outbox.ts`
- Test: `src/core/sync/convex.test.ts`

- [ ] **Step 1: Update the failing test**

In `src/core/sync/convex.test.ts`, add `Option` to the effect import (`import { Option } from 'effect'`) and replace the `convexOriginPattern` assertions (currently lines ~17 and ~23):

```ts
expect(convexOriginPattern('https://happy-otter-123.convex.cloud')).toEqual(
  Option.some('https://happy-otter-123.convex.cloud/*'),
)
expect(convexOriginPattern('not a url')).toEqual(Option.none())
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/core/sync/convex.test.ts -t "convexOriginPattern"`
Expected: FAIL — current return is `string | null`.

- [ ] **Step 3: Convert the function**

In `src/core/sync/convex.ts`, ensure `Option` is imported from `effect`, then replace `convexOriginPattern`:

```ts
export function convexOriginPattern(deploymentUrl: string): Option.Option<string> {
  try {
    const u = new URL(deploymentUrl)
    return Option.some(`${u.protocol}//${u.hostname}/*`)
  } catch {
    return Option.none()
  }
}
```

- [ ] **Step 4: Update the caller**

In `src/background/sync-outbox.ts`, add `Option` to its effect import, then replace lines 106–109:

```ts
    const pattern = convexOriginPattern(settings.convexUrl)
    if (Option.isNone(pattern))
      return { ok: false, detail: "That doesn't look like a valid URL.", pending }
    const granted = await browser.permissions
      .contains({ origins: [pattern.value] })
      .catch(() => false)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bunx vitest run src/core/sync/convex.test.ts`
Expected: PASS

- [ ] **Step 6: Effect diagnostics + full gate**

Run: `bun run effect:check` then `bun run check`
Expected: clean — this confirms `Option` returns + `isNone`/`.value` pass the language-service and typecheck.

- [ ] **Step 7: Commit**

```bash
git add src/core/sync/convex.ts src/core/sync/convex.test.ts src/background/sync-outbox.ts
git commit -m "refactor(sync): convexOriginPattern returns Option (Phase 4 pilot)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-review

- **Spec coverage:** Phase 0 (Task 1), Phase 1 (Task 2), Phase 2 (Task 3), Phase 3 (Task 4), Phase 4 pilot (Task 5). Full Phase 4 layer + Phases 5–6 are deferred to follow-up plans (below) — intentional split, each plan ships working software.
- **Placeholder scan:** every code step shows exact code. Task 4 Step 5 and Task 3 uploads test reference the existing test file's own fixtures rather than inventing them, because the harness helper differs per file — this is a real instruction, not a TODO.
- **Type consistency:** `OAuthError`, `Aria2RpcError`, `OffscreenSaveError` use a `message` field everywhere (required for `errorReason`/`classifyUploadError`). `convexOriginPattern` returns `Option.Option<string>`, consumed with `Option.isNone` + `.value`. `assertSecret(secret: string): void` signature is identical across `auth.ts` and both call sites.
- **Risk guards present:** Task 2 Step 1 (OAuth message → classifier) and Task 3 Step 1 (backend characterization tests written before the dedupe).

## Follow-up plans (not in this plan)

- **Phase 4 full — the resolve/parse `Option` layer.** Apply Task 5's pattern to: `mediaKeyFromUrl` (+5 callers: `detection-store.ts:12-13`, `index.ts:187/219/298`, using `Option.getOrElse`), `pickVideoVariant` (`resolver/index.ts:67` caller), `aria2OriginPattern`, `syndicationUrl`, `classifyFunctionMessage`, the `adapters/x` resolve chain (`resolveImageElement` → `resolveTweetContext` → `contextFromArticle`/`contextFromPath`, `playerPosterUrl`, `findScreenName`), and `clear/clearer.ts` `pageScope`/`clearableScope` + multi-tier finders. Each needs its caller sites mapped first; warrants its own plan.
- **Phase 5 (optional)** — background/entrypoints `Option` (`settleProbe` gone-vs-threw, `sendTabMessage`, `recoverSyndicationBody`, `lastUploadError`).
- **Phase 6 (optional)** — Effect spans/annotations in already-Effect code only.

## Execution handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-30-monadic-style-refactor.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
