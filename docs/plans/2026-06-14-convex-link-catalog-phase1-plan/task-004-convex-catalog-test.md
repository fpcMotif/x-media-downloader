# Task 004 — Convex catalog backend (test / Red)

- **type:** test
- **depends-on:** ["001"]
- **files:** `convex/catalog.test.ts` (new), `package.json` (+`convex-test` dev dep)

## Objective

Write failing function-level tests for the catalog backend using `convex-test` with a simulated auth
identity. Covers the `syncItems` mutation, idempotency, auth rejection, and per-user scoping. The
backend functions do not exist yet (built in 005), so these are Red.

**External-dependency isolation:** `convex-test` runs the functions against an in-memory Convex; no
real deployment or network is touched.

## BDD Scenario

```gherkin
Scenario: An authenticated user syncs a grabbed item's link
  Given an authenticated user
  And a MediaItem id "m-1", tweetId "1001", handle "alice", type "photo", url "https://pbs.twimg.com/...orig"
  When syncItems is called with that item
  Then a catalogItems row exists for (userId, "m-1")
  And it stores url, previewUrl, tweetId, handle, type, ext, capturedAt

Scenario: Re-syncing the same item is idempotent
  Given a catalogItems row already exists for (userId, "m-1")
  When syncItems is called again with the same item
  Then no duplicate row is created
  And the call succeeds

Scenario: Unauthenticated sync is rejected
  Given a caller with no authenticated identity
  When syncItems is called
  Then the call is rejected
  And no catalogItems row is written

Scenario: Catalog is scoped per user
  Given user A has a catalogItems row for "m-1"
  When user B lists their catalog
  Then user B does not see user A's "m-1" row
```

## Steps

1. Add `convex-test` dev dependency.
2. Set up the harness with `withIdentity` for users A and B and an anonymous caller.
3. Write the four scenarios above against the (not-yet-existing) `syncItems` / `listCatalog`.

## Verification

- `bun run test convex/catalog.test.ts` → **FAIL** (functions/schema absent).
