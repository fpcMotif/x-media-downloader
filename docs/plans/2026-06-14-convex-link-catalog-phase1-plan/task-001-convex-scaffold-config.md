# Task 001 — Convex scaffold + client wiring

- **type:** config
- **depends-on:** []
- **files:** `package.json`, `convex/` (new: `schema.ts`, `auth.config.ts`, `convex.json`, `tsconfig.json`), `src/core/sync/client.ts` (new), `wxt.config.ts`, `.env.local`/env handling

## Objective

Stand up a Convex deployment in the repo and wire a client into the extension behind the
(off-by-default) `cloudSyncEnabled` gate, with **no behavior change when sync is off**. This is the
enabling task; `syncItems` itself is built in 004/005.

Install `convex` + Convex Auth deps (bun). Create the `convex/` directory with an empty schema and an
auth-config skeleton. Add a `SyncClient` factory for the background SW (HTTP client) and a lazily
constructed reactive client for the popup, both constructed only when `cloudConvexUrl` is set.

## Contracts (signatures only — no bodies)

```ts
// src/core/sync/client.ts
export interface SyncItemsArgs { items: ReadonlyArray<CatalogItemInput> }
export interface SyncItemsResult { synced: number; deduped: number }
export interface SyncClient {
  syncItems(args: SyncItemsArgs): Promise<SyncItemsResult>
}
export function makeHttpSyncClient(convexUrl: string, getToken: () => Promise<string | null>): SyncClient
```

## BDD Scenario

```gherkin
Scenario: Scaffolding does not change default behavior
  Given cloudSyncEnabled is false and cloudConvexUrl is empty
  When the extension builds and loads
  Then no Convex client is constructed
  And no new network request is issued
  And the existing download/metrics behavior is unchanged
```

## Steps

1. `bun add convex` and the Convex Auth package; add `"convex:dev": "convex dev"` script.
2. `bunx convex dev --once` to initialize a deployment; commit `convex/convex.json` + `convex/tsconfig.json`.
3. Add `convex/schema.ts` = `defineSchema({})` (tables arrive in 005) and an `auth.config.ts` skeleton.
4. Add `src/core/sync/client.ts` with the `SyncClient` factory signature; add a popup-only reactive
   client provider that is constructed lazily and only when `cloudConvexUrl` is non-empty.
5. In `wxt.config.ts`, document the Convex deployment origin handling (host permission deferred to
   when a request is actually made; none needed while off).

## Verification

- `bunx convex dev --once` typechecks the empty schema.
- `bun run build` succeeds.
- With `cloudSyncEnabled` false / `cloudConvexUrl` empty: load the extension and confirm no Convex
  client construction and no new network call (DevTools network tab).
