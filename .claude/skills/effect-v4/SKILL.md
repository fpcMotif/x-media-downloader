---
name: effect-v4
description: Effect v4 (4.0.0-beta.78, "effect-smol") API patterns for this repo. Use BEFORE writing or editing any Effect code here (services, Layers, Schema, tagged errors, concurrency, retry). v4 is a rewrite — common v3 idioms (Effect.Service, Schema.optionalWith, decodeUnknownEither, ParseError, catchAll, makeSemaphore) DO NOT EXIST and will not compile.
---

# Effect v4 patterns (this repo)

Installed: `effect@4.0.0-beta.78`. `Schema`, `Semaphore`, `Result` live in core (`import { … } from "effect"`); there is **no** `@effect/schema`. Full grounding + citations: [docs/research/2026-06-07-grounding.md](../../../docs/research/2026-06-07-grounding.md) §0,§f,§g.

## v3 → v4 cheatsheet (do NOT use the left column)

| v3 (gone)                                            | v4 (use this)                                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `class X extends Effect.Service<X>()("X", {…})`      | `class X extends Context.Service<X, Shape>()("app/X") {}` + explicit `Layer`          |
| `X.Default` auto-layer                               | `Layer.succeed(X, impl)` / `Layer.effect(X, gen)` + `Layer.provide`                   |
| `Schema.optionalWith(s, { default })`                | `s.pipe(Schema.withDecodingDefaultKey(Effect.succeed(v)))`                            |
| `Schema.decodeUnknownEither` → `Either`/`ParseError` | `Schema.decodeUnknownResult` → `Result`/`SchemaError` (or `decodeUnknownSync` throws) |
| `Schema.union(a, b)` / `Schema.literal(...)`         | `Schema.Union([a, b])` / `Schema.Literals([...])` (ARRAYS)                            |
| `Effect.makeSemaphore(n)`                            | `Semaphore.make(n)` (own module); mutex = `Semaphore.make(1)`                         |
| `Effect.catchAll(() => …)`                           | `Effect.orElseSucceed(() => v)` / `Effect.catchCause` / `Effect.catchTag`             |
| `Schema.Schema.Type<typeof S>` (still works)         | prefer `typeof S.Type`                                                                |

## Service + Layer + DI

```ts
import { Context, Data, Effect, Layer, Schedule, Semaphore } from 'effect'

class DownloadError extends Data.TaggedError('DownloadError')<{ id: string; reason: string }> {}

class Settings extends Context.Service<Settings, { readonly get: Effect.Effect<Config> }>()('app/Settings') {}
const SettingsLive = Layer.succeed(Settings, { get: Effect.succeed(cfg) })

class Queue extends Context.Service<Queue, { readonly run: Effect.Effect<void, DownloadError> }>()('app/Queue') {}
const QueueLive = Layer.effect(
  Queue,
  Effect.gen(function* () {
    const settings = yield* Settings           // a service tag is itself yieldable
    const sem = yield* Semaphore.make(3)
    return { run: /* … */ }
  }),
).pipe(Layer.provide(SettingsLive))

// run:  Effect.runPromise(prog.pipe(Effect.provide(QueueLive)))
// test: Effect.provide(eff, Layer.succeed(Settings, fakeImpl))
```

## Concurrency + retry

```ts
yield * Effect.forEach(items, work, { concurrency }) // number | 'unbounded' | 'inherit'
self.pipe(
  Effect.retry(Schedule.exponential('100 millis', 2).pipe(Schedule.both(Schedule.recurs(3)))),
)
sem.withPermits(1)(effect) // bound a critical section
```

## Schema

```ts
import { Schema, Result, Effect } from 'effect'
const Item = Schema.Struct({
  id: Schema.String,
  type: Schema.Literals(['photo', 'video', 'gif']),
  w: Schema.optional(Schema.Number),
})
export type Item = typeof Item.Type
const Msg = Schema.Union([
  Schema.TaggedStruct('A', {}),
  Schema.TaggedStruct('B', { n: Schema.Number }),
])

const v = Schema.decodeUnknownSync(Item)(raw) // throws SchemaError
const r = Schema.decodeUnknownResult(Item)(raw) // Result<Item, SchemaError>
if (Result.isFailure(r)) handle(r.failure.issue) // .issue is a SchemaIssue tree
```

Repo conventions: pure transforms (resolver, filename) stay plain functions — no service ceremony; only effectful/injected things become `Context.Service`. Tooling: `bun run effect:check` runs the `@effect/language-service` diagnostics CLI; the editor plugin is wired via `tsconfig.json` `compilerOptions.plugins`.
