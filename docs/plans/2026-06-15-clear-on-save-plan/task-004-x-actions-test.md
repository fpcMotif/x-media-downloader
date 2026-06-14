# Task 004 (test): X actions + likes-surface test (Red)

- **Type:** test
- **depends-on:** []
- **Files:** `src/core/adapters/x/actions.test.ts` (new)

Failing tests for the new X "write" seam. These are DOM tests against fixture HTML (jsdom — the repo's `dom.test.ts` already does this; mirror its setup). **Assert by `data-testid`, never aria-label** (the live UI is localized — spec §6).

## Contract under test (implemented in 004-impl)

```ts
export function isLikesSurface(pathname: string): boolean
export function findLikeControl(article: Element): Element | null
export type ClearResult = { ok: boolean; reason?: 'no-article' | 'no-control' }
export function clearFromList(tweetId: string, opts: { unlike: boolean }, root?: ParentNode): ClearResult
```

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

- `isLikesSurface`: table-test the four paths above (true only for `/{handle}/likes`).
- `findLikeControl`: build an `article[data-testid="tweet"]` containing `[data-testid="unlike"]`; assert it's returned. Add a fixture whose only bookmark-ish text is a localized aria-label and assert resolution still works (proves no aria dependency).
- `clearFromList`: fixture with an article whose status link carries tweetId `t1` and an `unlike` control with a spied click; assert one click. Then a fixture lacking `t1`; assert `{ ok: false, reason: 'no-article' }` and no click. Use the project's existing tweetId-from-article resolution helper (`adapters/x` already extracts tweetId from the status href) rather than re-implementing it.

## Verification

- `bun run test src/core/adapters/x/actions.test.ts` — tests exist and **fail** (module not implemented). Red.
