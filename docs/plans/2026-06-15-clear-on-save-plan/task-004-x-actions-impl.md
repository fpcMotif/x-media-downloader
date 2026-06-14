# Task 004 (impl): X actions + likes-surface impl (Green)

- **Type:** impl
- **depends-on:** ["004-test"]
- **Files:** `src/core/adapters/x/actions.ts` (new)

Implement the X "write" seam so 004-test passes. This is the **first adapter code that acts on the page** rather than reading it (spec §3.1, §5 → ADR-0015). Keep all selector strings here (the single resolver) so live-DOM drift is contained.

## Contract (signatures only — no body logic in this plan)

```ts
export function isLikesSurface(pathname: string): boolean        // matches /^\/[^/]+\/likes$/
export function findLikeControl(article: Element): Element | null // article.querySelector('[data-testid="unlike"]')
export type ClearResult = { ok: boolean; reason?: 'no-article' | 'no-control' }
export function clearFromList(tweetId: string, opts: { unlike: boolean }, root?: ParentNode): ClearResult
```

## Behavior contract (from spec §3.1 / §6)

- `isLikesSurface(pathname)` → `/^\/[^/]+\/likes$/.test(pathname)`.
- `findLikeControl(article)` → resolves `[data-testid="unlike"]` within the article; returns `null` when absent (an unliked tweet shows `like`, not `unlike`). **No aria-label matching.**
- `clearFromList(tweetId, { unlike }, root = document)` → locates the `article[data-testid="tweet"]` whose status href carries `tweetId` (reuse the existing `adapters/x` tweetId resolver — match the **outer** post, not a quoted tweet), finds the like control, dispatches a real click, returns `{ ok: true }`; `{ ok:false, reason:'no-article' | 'no-control' }` otherwise. No direct network calls (X issues its own request on the click).

## BDD Scenario

```gherkin
Scenario: Likes surface is recognized by path
  Given the page path "/animalfarmchina/likes"
  Then isLikesSurface returns true
  And for "/i/bookmarks" it returns false
  And for "/home" it returns false
  And for "/animalfarmchina" it returns false

Scenario: findLikeControl resolves the already-liked control by data-testid
  Given a tweet article fixture containing a child with data-testid "unlike"
  When findLikeControl is called with that article
  Then it returns the element with data-testid "unlike"
  And it does not rely on any aria-label text

Scenario: clearFromList clicks the unlike control for the matched tweet
  Given a document fixture with an article for tweet "t1" containing an unlike control
  When clearFromList("t1", { unlike: true }) is called
  Then the unlike control receives a click
  And when no article for "t1" is present it performs no click and reports not-found
```

## Steps (what, not how)

- Create `src/core/adapters/x/actions.ts` with the contract above.
- Dispatch the click the same way a user would (a real `click()` on the control element); do not call X APIs.

## Verification

- `bun run test src/core/adapters/x/actions.test.ts` — 004-test passes (Green).
- `bun run typecheck` — clean.
