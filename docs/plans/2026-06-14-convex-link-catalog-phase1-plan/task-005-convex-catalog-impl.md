# Task 005 — Convex catalog backend (impl / Green)

- **type:** impl
- **depends-on:** ["004"]
- **files:** `convex/schema.ts`, `convex/auth.ts` + `convex/auth.config.ts`, `convex/catalog.ts`, `convex/http.ts` (auth routes), `convex/_generated/*`

## Objective

Implement Convex Auth (identity), the `catalogItems` table, and the `syncItems` mutation +
read queries so task 004 passes. Phase 1 semantics: **a confirmed catalog write IS "safe"** (no cloud
bytes yet). All rows are scoped by the authenticated identity's subject.

> Reconciliation gate: if task 015 selects the `sync_events`/`media_state` seam from
> `claude/elegant-franklin-g4ofol`, revise the table/function shape here to match before this is final.

## Contracts (signatures only — no bodies)

```ts
// convex/schema.ts
catalogItems: defineTable({
  userId: v.string(), mediaId: v.string(), tweetId: v.string(), handle: v.string(),
  type: v.union(v.literal('photo'), v.literal('video'), v.literal('gif')),
  url: v.string(), previewUrl: v.optional(v.string()), ext: v.string(),
  width: v.optional(v.number()), height: v.optional(v.number()), bitrate: v.optional(v.number()),
  sourceTweetUrl: v.optional(v.string()), capturedAt: v.number(),
  status: v.union(v.literal('pending'), v.literal('safe'), v.literal('failed')),
}).index('by_user_media', ['userId', 'mediaId'])

// convex/catalog.ts
export const syncItems = mutation({ args: { items: v.array(/* catalogItemInput */) }, handler })
export const listCatalog = query({ args: {}, handler })       // scoped to ctx.auth identity
export const statusCounts = query({ args: {}, handler })      // { safe, pending, failed }
```

## BDD Scenario

```gherkin
Scenario: Re-syncing the same item is idempotent
  Given a catalogItems row already exists for (userId, "m-1")
  When syncItems is called again with the same item
  Then no duplicate row is created
  And the call succeeds

Scenario: Unauthenticated sync is rejected
  Given a caller with no authenticated identity
  When syncItems is called
  Then the call is rejected and no row is written

Scenario: Catalog is scoped per user
  Given user A has a catalogItems row for "m-1"
  When user B lists their catalog
  Then user B does not see user A's "m-1" row
```

## Steps

1. Configure Convex Auth providers + `http.ts` auth routes; derive `userId` from the identity subject.
2. Define `catalogItems` + `by_user_media` index.
3. Implement `syncItems`: reject if no identity; for each item upsert by `(userId, mediaId)` — insert
   with `status: 'safe'` if absent, no-op if present; return `{ synced, deduped }`.
4. Implement `listCatalog` and `statusCounts`, both filtered by the caller's `userId` via the index.

## Verification

- `bun run test convex/catalog.test.ts` → **GREEN**.
- `bunx convex dev --once` typechecks; codegen committed.
