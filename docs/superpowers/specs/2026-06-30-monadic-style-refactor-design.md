# Monadic-Style Refactor — Design Spec

- **Status:** Approved (design) — 2026-06-30
- **Topic:** Finish the Effect adoption the codebase already started — replace *escaping*
  raw `throw`s with `Data.TaggedError`, lift the resolve/parse layer's `T | null` returns
  to `Option`, and add structured debug context. **Not** a rewrite; no new monad
  abstractions; builds on the existing `effect` dependency.
- **Relationship to ADRs:** extends **ADR-0004** (effect-v4-beta-core) with an error
  taxonomy + `Option` conventions; respects **ADR-0014**'s functional-core /
  imperative-shell split. Touches no posture ADR.

## 1. Goal

The codebase is already functional-core / imperative-shell: discriminated-union results
(`UploadOutcome {kind:'success'|'failure'}`, `ParsedSource.ok`, `OutcomeEffects`
intents-as-data), heavy `effect/Schema`, and `Data.TaggedError` for download/sync
failures. Two jobs were left half-done:

1. **Error typing is inconsistent** — ~30 raw `throw new Error(...)` remain in non-test
   code while 5 sites are already proper tagged errors.
2. **`Option` is used in exactly one file** (`clear/worklist.ts`) despite ~87 nullable
   sites — the "find / get / resolve / parse" layer hand-rolls `T | null`.

This spec closes those two gaps **selectively and reversibly**, with each step shippable
on its own with the full `bun run check` gate green. It explicitly is **not** an attempt
to thread `Effect<...>` through the whole program or to monadify wire/DOM/React/hot-path
code.

## 2. Locked decisions (chosen with the user — not re-litigated)

1. **Foundation — build on existing `effect`.** Use `Option` (the "Maybe / `T?`"),
   `Either`, and `Data.TaggedError`. **No** hand-rolled `Maybe`/`Result` layer.
2. **Depth — shallow.** Typed errors + `Option` for nullables + debug context. **No**
   control-flow rewrite; **no** Effect-ifying of async pipelines. `Effect<...>` stays
   only where it already lives (download strategies, queue, settings service,
   `handleDownload`, the convex port).
3. **Drive/Dropbox throws — leave entirely as-is.** Their ~15 inner throws are caught by
   `runUpload`'s `catch → errorReason` and collapsed into the byte-stable
   `UploadOutcome.reason` strings (`drive HTTP 500: …`). That *is* the functional pattern
   (throw-locally, map-at-boundary into a result type). Converting them would buy nothing
   typed (they collapse to a string anyway) and risks blanking the deliberately
   byte-identical reason strings. `cloud/drive.ts` and `cloud/dropbox.ts` are out of
   scope, including their local `null` accumulators.
4. **`Option` scope — selective.** Convert resolve / parse / domain-mapping functions and
   multi-tier finders (where `Option.orElse` clarifies fallback). Keep single-selector DOM
   queries, wire/schema types, Preact state, HTTP-header fields, Chrome API rows, and hot
   loops as raw nullable.
5. **Effect spans/annotations — deferred** to an optional Phase 6, scoped strictly to code
   already running inside the Effect runtime.

## 3. Guardrails — the keep-nullable discipline

`Option` is a tool for *composable absence in domain logic*, not a blanket replacement for
`null`. Decision rule:

| Convert to `Option` (TO-OPTION) | Keep raw nullable (KEEP-NULLABLE) |
|---|---|
| Pure domain `find/get/resolve/parse` returning `T \| null/undefined` | Convex wire / schema types (generated `Doc`, `v.optional(...)`, `OAuthTokens.account`, `UploadOutcome.remoteId`, `FileMetadata`) |
| Multi-tier lookups where `Option.orElse` expresses priority | HTTP-header fields (`FetchPort.contentType/contentLength`, `totalBytes`) — "absent header" is the API's own contract |
| Domain-mapping helpers (`pathname → scope`, `state → outcome`) | Preact/React state (`useState<string \| null>`, `BadgeState.key`, `CloudUploadStatus.lastError`) |
| `let x: T \| null = null` accumulators later asserted via a throw (→ `Option` + `getOrThrowWith`) — **except** in out-of-scope drive/dropbox | Chrome API result fields consumed immediately (`ReconcileRow.state/exists`, `InterruptReason`) |
| | Hot Convex ingest-loop `.first()` results (`row`, `seen`) — allocation in a batch path |
| | Semantic-nullable params (`parentId = null` ⇒ app root, `totalBytes = null` ⇒ unknown size) |

**Hard non-goal (corrects the auditors):** do **not** wrap a pure synchronous function in
`Effect.promise` / `Effect.tryCatch` / `Effect.withSpan` just to attach a debug
annotation. That forces a sync, runtime-free function into the Effect runtime and violates
both "shallow" and ADR-0014's pure core. Debug context in the pure layer comes from
`Option.getOrThrowWith` messages and tagged-error fields instead.

## 4. Error taxonomy

### 4.1 Frontend — `src/core/errors/index.ts` (additive)

Add three tagged errors alongside the existing `DownloadError` / `DetectError`:

```ts
export class OAuthError extends Data.TaggedError('OAuthError')<{
  readonly message: string                 // MUST stay the carried string (see risk §8.1)
  readonly context?: 'malformed-url' | 'consent-failed' | 'state-mismatch'
    | 'no-code' | 'no-token' | 'non-json' | 'token-endpoint' | 'no-offline-grant'
}> {}

export class Aria2RpcError extends Data.TaggedError('Aria2RpcError')<{
  readonly message: string
  readonly code?: number
  readonly method?: string
}> {}

export class OffscreenSaveError extends Data.TaggedError('OffscreenSaveError')<{
  readonly message: string
}> {}
```

**`errorReason` interplay (load-bearing).** `Data.TaggedError` produces an `Error`
subclass; the `message` *field* populates `Error.prototype.message`, so the existing
central helper `errorReason(err) = err instanceof Error ? err.message : String(err)`
(`src/core/error.ts`) keeps returning the same string. This is why every tagged error here
carries a `message` field rather than only a `reason`.

Leave as already-tagged: `ConvexHttpError`, `ConvexFunctionError`, `ConvexMalformedError`,
`UnsafeUrlError`.

### 4.2 Backend — `backend/convex/` (separate package, **no `effect` dependency**)

`backend/package.json` depends only on `convex`. Pulling `effect` into the Convex
serverless bundle to tag two auth throws is over-engineering — the auditors' "share
`AuthorizationError` across packages" suggestion is rejected.

Instead:

1. **Dedupe** the two identical `assertSecret` functions (`sync.ts:37-45`,
   `uploads.ts:46-54`) into one shared helper `backend/convex/auth.ts`.
2. Keep the thrown **message strings byte-stable** (`unauthorized: deployment has no
   SYNC_SHARED_SECRET configured` / `unauthorized: bad or missing sync secret`) so the
   client's error classification is unaffected (see risk §8.3).
3. *Optional, only if envelope-compatible:* throw Convex-native
   `ConvexError({ tag: 'Unauthorized', reason })` instead of `Error` for a structured
   payload. Gated on verifying the client receives the same classifiable signal — else
   keep plain `Error` and treat Phase 2 as a pure DRY consolidation.

## 5. `Option` adoption — the resolve/parse layer

House pattern to mirror (the one existing correct usage,
`clear/worklist.ts:53-62`): `Schema.decodeUnknownOption` + `Option.isSome` / `.value`;
new code uses `Option.fromNullable`, `Option.map/flatMap/orElse`, and `Option.match` at
call sites.

Convert set (signatures become `=> Option<T>`):

- **`adapters/x` resolve chain** (highest-value — genuine multi-tier `orElse` clarity):
  `resolveImageElement`, `resolveTweetContext`, `contextFromArticle`, `contextFromPath`,
  `playerPosterUrl`, `findScreenName` (`index.ts`); `mediaKeyFromUrl` (`dom.ts`);
  `syndicationUrl` (`syndication.ts`).
- **Domain pickers / parsers:** `pickVideoVariant` (`resolver/index.ts`),
  `findFreshMediaItem` + `refreshMediaUrl` (`download/media-url-refresh.ts`),
  `convexOriginPattern` (`sync/convex.ts`), `aria2OriginPattern` (`download/aria2.ts`),
  `classifyFunctionMessage` (`sync/status.ts`).
- **`clear/clearer.ts`:** domain mappings `pageScope`, `clearableScope`; multi-tier
  finders `findNotInterestedItem`, `findFeedbackButton`. **Keep nullable:** single-selector
  DOM helpers `ownControl`, `cellOf`, `findArticle`, `clearControl`, `caretControl`,
  `tweetIdOfArticle`, `linkContext`.
- **`download/metrics.ts` `outcomeFromState`:** borderline (tiny map, immediate `switch`);
  convert only if its caller reads cleaner — otherwise keep nullable.

Where a converted function previously had a caller that *threw* on the `null`, lift that
to `Option.getOrThrowWith(() => new DetectError({ reason: '…context…' }))` — this is a
debug-info win (named, contextual error instead of a bare `null` deref downstream).

## 6. Phasing

Each phase is independently shippable; the gate (`bun run check` + `bun run effect:check`
+ `bun run test:backend`) must be green before the next. Ordered smallest-blast-radius
first.

| Phase | Scope | Files | Tests |
|---|---|---|---|
| 0 | Error taxonomy (additive) | `core/errors/index.ts` | new unit asserts tag + `.message` |
| 1 | Migrate `OAuthError` → tagged; preserve messages | `cloud/oauth.ts` (8 sites) | `oauth.test.ts`, `status.test.ts` |
| 2 | Dedupe backend `assertSecret` (+ optional `ConvexError`) | `backend/convex/{sync,uploads,auth}.ts` | `sync.test.ts`, `uploads.test.ts` |
| 3 | `aria2`(2) + `fetched-strategy`(1) throws → tagged | `download/aria2.ts`, `download/fetched-strategy.ts` | existing `*.test.ts` |
| 4 | `Option` across resolve/parse layer (§5), split per dir (4a adapters/x · 4b pickers · 4c origin/classify · 4d clear) | per §5 | per-fn `Some/None` + `getOrThrowWith` |
| 5 *(optional)* | background/entrypoints `Option` (`settleProbe` gone-vs-threw, `sendTabMessage`, `recoverSyndicationBody`, `lastUploadError`) | `background/*`, `entrypoints/*` | existing |
| 6 *(optional/deferred)* | Effect spans/annotations in already-Effect code | strategies, queue, settings, convex port, `handleDownload` | n/a |

Phases 0–4 are the core deliverable. 5–6 are opt-in.

## 7. Debug-info strategy (the "useful debug info" ask)

Three mechanisms, in order of fit:

1. **Structured tagged-error fields** — survive logging and enable pattern-matching:
   `OAuthError{message,context}`, `Aria2RpcError{code,method,message}`,
   `OffscreenSaveError{message}`, backend `{tag:'Unauthorized',reason}`.
2. **`Option.getOrThrowWith(() => new …Error({reason}))`** at the boundary where a `null`
   was previously asserted — turns a silent/`null` failure into a named, contextual error.
3. **Effect spans/annotations** (`Effect.annotateLogs` / `withSpan`) — **Phase 6 only**,
   and **only** in code already inside the Effect runtime.

Explicitly excluded: span/annotation wrapping of pure-sync functions (§3 non-goal).

## 8. Risks & constraints

### 8.1 `OAuthError.message` is load-bearing
`classifyUploadError` (`cloud/status.ts:35`) maps errors by **regex over the message
string** (`/no refresh_token/i`, `/HTTP 401/`, …), reached via `errorReason(err).message`.
The tagged `OAuthError` therefore **must** carry the same `message` text. Guard: a Phase 1
test asserts each of the 8 messages still maps to the same `classifyUploadError` line.

### 8.2 Drive/Dropbox byte-stable strings
Left untouched by decision §2.3 precisely because `runUpload` stringifies them into
byte-stable `UploadOutcome.reason`s that `classifyUploadError` also matches. No churn
there.

### 8.3 Backend error envelope
The client's `makeConvexHttpPort` reads `body.errorMessage` and the popup classifies it.
Phase 2 must keep the thrown message stable; adopt `ConvexError` only after verifying the
client still receives an equivalent classifiable signal via `convex-test` + a client
`sync/convex.test.ts` round-trip. If uncertain, Phase 2 is DRY-only.

### 8.4 Tooling gates
`effect-language-service` (`bun run effect:check`) must stay clean — it flags `Option`
misuse and floating effects. Run it per phase, not just at the end.

### 8.5 Performance
No `Option` in the Convex ingest loops or per-chunk upload paths (§3) — avoids per-item
allocation in batch/streaming hot paths.

## 9. Testing strategy

- **Per phase:** existing units stay green; add assertions wherever a type or message
  changes (tagged-error `_tag` + fields; converted functions return `Option.some/none`;
  `getOrThrowWith` messages).
- **Regression guards:** §8.1 OAuth message→classifier map; §8.3 backend message round-trip.
- **Full gate before each merge:** `bun run check` (oxfmt · oxlint · `tsgo --noEmit` ·
  vitest) **+** `bun run effect:check` **+** `bun run test:backend`.

## 10. ADR impact

- **Extend ADR-0004 (effect-v4-beta-core)** with: (a) the error taxonomy and the
  `message`-field convention for `errorReason` compatibility, (b) the `Option`
  conventions and the §3 keep-nullable discipline. A short standalone **ADR-0017 — Error
  taxonomy & `Option` conventions** is acceptable if preferred over amending 0004.

## 11. Out of scope / non-goals

- No hand-rolled `Maybe`/`Result`.
- No `Effect<...>` threading beyond where it already exists; no async-pipeline rewrites.
- `cloud/drive.ts` and `cloud/dropbox.ts` untouched (decision §2.3).
- No `effect` dependency added to the Convex backend.
- No blanket `Option`-ification of DOM queries, wire types, React state, or hot loops.
- No control-flow restructuring — same branches, expressed over `Option`/tagged errors.

## Appendix A — Effect-TS primer

The refactor leans on three constructs from `effect`. Each replaces an ad-hoc
pattern already in the code.

### The `Option` railway (mental model)

A nullable value enters `Option.fromNullable`, which routes a present value onto a
**Some** track and an absent value onto a **None** track. The Some track runs your
transforms (`map`, `flatMap`, `orElse`); the None track **short-circuits** — none of
those transforms run. Both tracks rejoin at `Option.match` (handle each side) or at
`Option.getOrThrowWith` (turn absence into a typed error). The absence case is handled
once, by the type, instead of by a `=== null` check the caller can forget.

```
string | null ─▶ fromNullable ─┬─▶ Some<string> ─(map · orElse)─┐
                               │                                 ├─▶ match / getOrThrowWith
                               └─▶ None ───(short-circuits)──────┘
```

### `Option<T>` — replaces `T | null` on resolve/parse functions

```ts
// before
function mediaKeyFromUrl(url: string): string | null {
  return parseKey(url) ?? null
}
const k = mediaKeyFromUrl(u)
if (k === null) return            // easy to forget
use(k)

// after
const mediaKeyFromUrl = (url: string): Option.Option<string> =>
  Option.fromNullable(parseKey(url))
Option.match(mediaKeyFromUrl(u), {
  onNone: () => skip(),
  onSome: (k) => use(k),          // absence is typed
})
```

### `Data.TaggedError` — replaces raw `throw new Error`

```ts
// before
class OAuthError extends Error {
  readonly _tag = 'OAuthError'
  constructor(reason: string) { super(reason) }
}
throw new OAuthError('state mismatch (CSRF)')

// after — _tag + structured fields; `message` keeps errorReason()/classifyUploadError working
class OAuthError extends Data.TaggedError('OAuthError')<{
  readonly message: string
  readonly context?: 'state-mismatch'
}> {}
throw new OAuthError({ message: 'state mismatch (CSRF)', context: 'state-mismatch' })
```

### `Option.getOrThrowWith` — the bridge (debug info)

```ts
// before
const item = resolveImageElement(img)
if (item === null) throw new Error('no media')   // where? why?

// after — None becomes a named, contextual error
const item = Option.getOrThrowWith(
  resolveImageElement(img),
  () => new DetectError({ reason: `no media: ${img.src}` }),
)
```
