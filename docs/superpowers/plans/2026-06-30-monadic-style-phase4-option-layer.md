# Monadic-Style Phase 4 — Option Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the codebase's independent nullable *resolve/parse/find* helpers to Effect's `Option`, extending the Phase-4 pilot (`convexOriginPattern`) — only where `Option` is a genuine readability/safety win, not ceremony.

**Architecture:** Each target is a pure domain function returning `T | null`/`T | undefined` whose callers branch on absence. We make the return `Option.Option<T>` and update call sites with the house idioms: `Option.isNone(x)` guards + `x.value`, `Option.getOrElse(x, () => fallback)` for `?? fallback`, and `Option.getOrNull(x)` in tests for minimal-diff assertions. No control-flow restructuring.

**Tech stack:** TypeScript 6 (tsgo), `effect@4.0.0-beta.92`, WXT + Preact, Vitest, oxlint.

**Source spec:** `docs/superpowers/specs/2026-06-30-monadic-style-refactor-design.md` (§2 locked decisions, §3 keep-nullable discipline). Pilot precedent: commit `f2f8a75` (`convexOriginPattern`), and `src/core/clear/worklist.ts` (`Option.isSome`/`.value`).

---

## Scope — curated, not mechanical

A read-only audit of every Phase-4 candidate (with its exact callers across `.ts` **and** `.tsx`) showed the conversions split cleanly:

- **In scope (this plan)** — independent leaf/`find` resolvers whose callers are simple absence-guards: `aria2OriginPattern`, `syndicationUrl`, `pickVideoVariant`, `pageScope`, `tweetIdOfArticle`, `findArticle`, `findNotInterestedItem`, `findFeedbackButton`.
- **Declined** — the entangled `adapters/x` DOM→MediaItem resolve chain (`resolveImageElement`, `resolveTweetContext`, `contextFromArticle`, `contextFromPath`, `linkContext`, `resolveHoverItem`, `detectRenderedImageElements`) and `mediaKeyFromUrl`/`videoPosterUrl`. See **Declined conversions** at the end for the evidence — converting them is net-negative.
- **Keep-nullable** — private one-shot guards and JSON walkers: `clearControl`, `ownControl`, `caretControl`, `cellOf`, `classifyFunctionMessage`, `findScreenName`, `playerPosterUrl`, `videoTweetsNeedingRecovery`, `detectFromJson`.

Each in-scope task is independently shippable.

## Conventions

- **Caller guards:** `if (x === null)` → `if (Option.isNone(x))`; later uses of the value → `x.value`. `a ?? b` → `Option.getOrElse(x, () => b)`.
- **Test assertions (minimal diff):** wrap the call in `Option.getOrNull(...)` so existing matchers stay: `.toBe('AAA')` and `.toBe(null)`/`.toBeNull()` are unchanged; `?.url` chains stay. Add `import { Option } from 'effect'` to each touched test file.
- **Import:** add `Option` to the file's existing `effect` import, or `import { Option } from 'effect'`.

## Gate (run before each commit; environment is healthy on effect 4.0.0-beta.92)

- Per-task tests: `bunx vitest run <files>`
- `bun run typecheck` → exit 0 (the real proof every caller is consistent with the new return type)
- `bunx oxlint <changed files>` → no new issues
- `bun run effect:check` → no NEW diagnostics (3 pre-existing `unnecessaryFailYieldableError` messages in `download/fetched-strategy.ts` are expected)
- DO NOT run `oxfmt`/`bun run check` (oxfmt is broken repo-wide on a Windows line-ending mismatch; pre-existing). Ignore the pre-existing `src/entrypoints/popup/popup-layout.test.ts` failure (a separate CRLF artifact).

## File structure

| File | Change | In task |
|---|---|---|
| `src/core/download/aria2.ts` | `aria2OriginPattern` → Option | 1 |
| `src/entrypoints/options/panels/downloads.tsx` | 2 callers | 1 |
| `src/core/download/aria2.test.ts` | assertions | 1 |
| `src/core/adapters/x/syndication.ts` | `syndicationUrl` → Option | 2 |
| `src/entrypoints/background.ts` | 1 caller | 2 |
| `src/core/adapters/x/syndication.test.ts` | assertions | 2 |
| `src/core/resolver/index.ts` | `pickVideoVariant` → Option + caller | 3 |
| `src/core/resolver/resolver.test.ts` | assertions | 3 |
| `src/core/clear/clearer.ts` | `pageScope`, `tweetIdOfArticle`, `findArticle`, `findNotInterestedItem`, `findFeedbackButton` → Option; `clearableScope` body | 4–6 |
| `src/entrypoints/overlay.content/handlers.ts` | callers (pageScope ×3, tweetIdOfArticle, findArticle ×2) | 4, 5 |
| `src/entrypoints/overlay.content/index.tsx` | callers (findArticle, findNotInterestedItem, findFeedbackButton) | 5, 6 |
| `src/core/clear/clearer.test.ts` | assertions | 4–6 |

---

## Task 1: `aria2OriginPattern` → Option (exact pilot mirror)

**Files:** `src/core/download/aria2.ts`; callers `src/entrypoints/options/panels/downloads.tsx`; test `src/core/download/aria2.test.ts`.

- [ ] **Step 1 — update the test (watch it fail).** In `aria2.test.ts`, add `import { Option } from 'effect'` and wrap the two assertions:

```ts
it('derives a host-only match pattern (drops the port)', () => {
  expect(Option.getOrNull(aria2OriginPattern('http://localhost:6800/jsonrpc'))).toBe('http://localhost/*')
  expect(Option.getOrNull(aria2OriginPattern('https://aria.example.com/rpc'))).toBe('https://aria.example.com/*')
})

it('returns none for an unparseable url', () => {
  expect(Option.getOrNull(aria2OriginPattern('not a url'))).toBe(null)
})
```

Run `bunx vitest run src/core/download/aria2.test.ts` → FAIL (return is still `string | null`).

- [ ] **Step 2 — convert the function.** In `aria2.ts`, ensure `Option` is imported from `effect`, then replace `aria2OriginPattern`:

```ts
/**
 * Chrome match-pattern for an aria2 RPC URL's origin, suitable for a runtime
 * `permissions.request({ origins })` call. Host-only — match patterns omit the
 * port (`http://localhost:6800/jsonrpc` → `http://localhost/*`). None if the URL
 * is unparseable.
 */
export function aria2OriginPattern(rpcUrl: string): Option.Option<string> {
  try {
    const u = new URL(rpcUrl)
    return Option.some(`${u.protocol}//${u.hostname}/*`)
  } catch {
    return Option.none()
  }
}
```

- [ ] **Step 3 — update the 2 callers** in `src/entrypoints/options/panels/downloads.tsx` (add `Option` to its `effect` import):

```ts
const pattern = aria2OriginPattern(rpcUrl)
if (Option.isNone(pattern)) {
  setAria2Granted(null)
  return
}
```
and
```ts
const pattern = aria2OriginPattern(settings.aria2RpcUrl)
if (Option.isNone(pattern)) return
```
Any later use of `pattern` in those blocks becomes `pattern.value`.

- [ ] **Step 4 — gate.** `bunx vitest run src/core/download/aria2.test.ts` (PASS) · `bun run typecheck` (exit 0) · `bunx oxlint src/core/download/aria2.ts src/core/download/aria2.test.ts src/entrypoints/options/panels/downloads.tsx`.

- [ ] **Step 5 — commit:**
```bash
git add src/core/download/aria2.ts src/core/download/aria2.test.ts src/entrypoints/options/panels/downloads.tsx
git commit -m "refactor(download): aria2OriginPattern returns Option

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `syndicationUrl` → Option

**Files:** `src/core/adapters/x/syndication.ts`; caller `src/entrypoints/background.ts`; test `src/core/adapters/x/syndication.test.ts`.

- [ ] **Step 1 — update the test (watch it fail).** Add `import { Option } from 'effect'`; rewrite:

```ts
it('builds the tweet-result URL with id + token + lang', () => {
  const url = Option.getOrNull(syndicationUrl('2068286123399676218'))
  expect(url).not.toBeNull()
  const u = new URL(url!)
  expect(u.host).toBe('cdn.syndication.twimg.com')
  expect(u.pathname).toBe('/tweet-result')
  expect(u.searchParams.get('id')).toBe('2068286123399676218')
  expect(u.searchParams.get('token')).toBe('5hpndyxr8f')
  expect(u.searchParams.get('lang')).toBe('en')
})
it('returns none for a non-tweet id', () => {
  expect(Option.getOrNull(syndicationUrl('not-an-id'))).toBe(null)
})
```
Run `bunx vitest run src/core/adapters/x/syndication.test.ts` → FAIL.

- [ ] **Step 2 — convert the function.** In `syndication.ts`, import `Option`, then:

```ts
/** The syndication `tweet-result` URL for `tweetId`, or None if it isn't a tweet id. */
export function syndicationUrl(tweetId: string): Option.Option<string> {
  if (!isTweetId(tweetId)) return Option.none()
  const u = new URL('https://cdn.syndication.twimg.com/tweet-result')
  u.searchParams.set('id', tweetId)
  u.searchParams.set('token', syndicationToken(tweetId))
  // `lang` mirrors X's own widget call and keeps the response shape stable.
  u.searchParams.set('lang', 'en')
  return Option.some(u.toString())
}
```

- [ ] **Step 3 — update the caller** in `src/entrypoints/background.ts` (~line 238; add `Option` to its `effect` import):

```ts
const url = syndicationUrl(tweetId)
if (Option.isNone(url)) return null
```
Any later use of `url` in that scope becomes `url.value`.

- [ ] **Step 4 — gate.** `bunx vitest run src/core/adapters/x/syndication.test.ts` · `bun run typecheck` · `bunx oxlint src/core/adapters/x/syndication.ts src/core/adapters/x/syndication.test.ts src/entrypoints/background.ts`.

- [ ] **Step 5 — commit:**
```bash
git add src/core/adapters/x/syndication.ts src/core/adapters/x/syndication.test.ts src/entrypoints/background.ts
git commit -m "refactor(adapters): syndicationUrl returns Option

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `pickVideoVariant` → Option

**Files:** `src/core/resolver/index.ts` (fn + internal caller ~line 67); test `src/core/resolver/resolver.test.ts`.

- [ ] **Step 1 — update the test (watch it fail).** Add `import { Option } from 'effect'`; rewrite:

```ts
it('selects the highest-bitrate mp4 and ignores non-mp4 variants', () => {
  const variants = [
    { content_type: 'application/x-mpegURL', url: 'playlist.m3u8' },
    { content_type: 'video/mp4', bitrate: 256000, url: 'low.mp4' },
    { content_type: 'video/mp4', bitrate: 2176000, url: 'high.mp4' },
    { content_type: 'video/mp4', bitrate: 832000, url: 'mid.mp4' },
  ]
  expect(Option.getOrNull(pickVideoVariant(variants))?.url).toBe('high.mp4')
})

it('returns none when there is no mp4 variant', () => {
  expect(Option.getOrNull(pickVideoVariant([{ content_type: 'application/x-mpegURL', url: 'p.m3u8' }]))).toBeNull()
})
```
(If a third test exists at line ~38, wrap its `pickVideoVariant(...)` call in `Option.getOrNull(...)` the same way.) Run `bunx vitest run src/core/resolver/resolver.test.ts` → FAIL.

- [ ] **Step 2 — convert the function.** In `resolver/index.ts`, import `Option`, then:

```ts
/**
 * Select the highest-bitrate MP4 variant; ignore HLS/non-mp4. None if no MP4
 * variant exists. Mirrors gallery-dl's max-bitrate selection.
 */
export function pickVideoVariant(variants: ReadonlyArray<Variant>): Option.Option<Variant> {
  const mp4 = variants.filter((v) => v.content_type === 'video/mp4')
  if (mp4.length === 0) return Option.none()
  return Option.some(mp4.reduce((best, v) => ((v.bitrate ?? 0) > (best.bitrate ?? 0) ? v : best)))
}
```

- [ ] **Step 3 — update the internal caller** (~line 67 in the same file):

```ts
const variant = m.video_info ? pickVideoVariant(m.video_info.variants) : Option.none()
if (Option.isNone(variant)) return
```
Replace subsequent `variant.url`/`variant.bitrate` uses in that block with `variant.value.url` / `variant.value.bitrate`.

- [ ] **Step 4 — gate.** `bunx vitest run src/core/resolver/` · `bun run typecheck` · `bunx oxlint src/core/resolver/index.ts src/core/resolver/resolver.test.ts`.

- [ ] **Step 5 — commit:**
```bash
git add src/core/resolver/index.ts src/core/resolver/resolver.test.ts
git commit -m "refactor(resolver): pickVideoVariant returns Option

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: `pageScope` → Option (clearer.ts)

**Files:** `src/core/clear/clearer.ts` (`pageScope` fn + `clearableScope` body); callers `src/entrypoints/overlay.content/handlers.ts` (~143, 178, 194); test `src/core/clear/clearer.test.ts`.

- [ ] **Step 1 — update the test (watch it fail).** Add `import { Option } from 'effect'`; rewrite:

```ts
it('pageScope is list-specific (Likes→like, Bookmarks→bookmark, else none)', () => {
  expect(Option.getOrNull(pageScope('/lambda_functor/likes'))).toBe('like')
  expect(Option.getOrNull(pageScope('/i/bookmarks'))).toBe('bookmark')
  expect(Option.getOrNull(pageScope('/i/bookmarks/all'))).toBe('bookmark')
  expect(Option.getOrNull(pageScope('/home'))).toBe(null)
  expect(Option.getOrNull(pageScope('/jack/status/123'))).toBe(null)
})
```
Run `bunx vitest run src/core/clear/clearer.test.ts` → FAIL.

- [ ] **Step 2 — convert `pageScope` and keep `clearableScope` nullable** (bounds the ripple). In `clearer.ts`, import `Option`, then:

```ts
export function pageScope(pathname: string): Option.Option<MembershipScope> {
  if (/\/likes\/?$/.test(pathname)) return Option.some('like')
  if (/\/bookmarks(\/|$)/.test(pathname)) return Option.some('bookmark')
  return Option.none()
}
```
and update `clearableScope`'s body (signature unchanged → no ripple to its callers):

```ts
export function clearableScope(pathname: string, root: ParentNode): ClearScope | null {
  return Option.getOrElse(pageScope(pathname), () =>
    isForYouHome(pathname, root) ? 'notInterested' : null,
  )
}
```

- [ ] **Step 3 — update the 3 `pageScope` callers** in `handlers.ts` (add `Option` to its `effect` import):

~143:
```ts
const scope = pageScope(deps.location.pathname)
if (import.meta.env.DEV)
  deps.clearLog('clear-visible request · page scope =', Option.getOrElse(scope, () => '(not a Likes/Bookmarks page)'))
void (async () => {
  if (Option.isNone(scope)) {
```
~178:
```ts
deps.clearLog('drain-page · downloading', items.length, 'items · scope', Option.getOrNull(pageScope(deps.location.pathname)))
```
~194:
```ts
const scope = pageScope(deps.location.pathname)
if (import.meta.env.DEV)
  deps.clearLog('sweep request · page scope =', Option.getOrElse(scope, () => '(not a Likes/Bookmarks page)'))
if (Option.isNone(scope)) {
```
Replace later uses of `scope` in those blocks with `scope.value`.

- [ ] **Step 4 — gate + commit.** `bunx vitest run src/core/clear/ src/entrypoints/overlay.content/` · `bun run typecheck` · `bunx oxlint src/core/clear/clearer.ts src/core/clear/clearer.test.ts src/entrypoints/overlay.content/handlers.ts`.
```bash
git add src/core/clear/clearer.ts src/core/clear/clearer.test.ts src/entrypoints/overlay.content/handlers.ts
git commit -m "refactor(clear): pageScope returns Option

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: `tweetIdOfArticle` + `findArticle` → Option (coupled — `findArticle` calls `tweetIdOfArticle`)

**Files:** `src/core/clear/clearer.ts`; callers `src/entrypoints/overlay.content/handlers.ts` (~211, 261, 296) and `src/entrypoints/overlay.content/index.tsx` (~113); test `src/core/clear/clearer.test.ts`.

- [ ] **Step 1 — update the tests (watch them fail).** In `clearer.test.ts`:

```ts
it('resolves tweetId from the permalink', () => {
  expect(Option.getOrNull(tweetIdOfArticle(article({ tweetId: '1900000000000000001' })))).toBe('1900000000000000001')
})
it('returns none when no status link is present', () => {
  expect(Option.getOrNull(tweetIdOfArticle(document.createElement('article')))).toBe(null)
})
it('findArticle id-match guard: only returns the matching tweetId', () => {
  document.body.append(article({ tweetId: '11' }), article({ tweetId: '22', bookmarked: true }))
  const found = findArticle(document, '22')
  expect(Option.getOrNull(found)).not.toBe(null)
  expect(Option.getOrNull(tweetIdOfArticle(Option.getOrNull(found)!))).toBe('22')
  expect(Option.getOrNull(findArticle(document, '999'))).toBe(null)
})
```
Run `bunx vitest run src/core/clear/clearer.test.ts` → FAIL.

- [ ] **Step 2 — convert both functions** in `clearer.ts`:

```ts
export function tweetIdOfArticle(article: Element): Option.Option<string> {
  const anchors = [...article.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]')].filter(
    (a) => a.closest(QUOTE_CARD_SEL) === null,
  )
  const ordered = [
    ...anchors.filter((a) => a.querySelector('time') !== null),
    ...anchors.filter((a) => a.querySelector('time') === null),
  ]
  for (const a of ordered) {
    const m = /\/status\/(\d+)/.exec(a.getAttribute('href') ?? '')
    if (m?.[1]) return Option.some(m[1])
  }
  return Option.none()
}

export function findArticle(root: ParentNode, tweetId: string): Option.Option<Element> {
  for (const article of root.querySelectorAll(TWEET_ARTICLE_SEL)) {
    const id = tweetIdOfArticle(article)
    if (Option.isSome(id) && id.value === tweetId) return Option.some(article)
  }
  return Option.none()
}
```

- [ ] **Step 3 — update callers.**

`handlers.ts` ~211 (`tweetIdOfArticle`):
```ts
const tweetId = tweetIdOfArticle(article)
if (Option.isNone(tweetId) || seen.has(tweetId.value)) continue
```
`handlers.ts` ~261 (`findArticle`):
```ts
const article = findArticle(deps.document, req.tweetId)
if (Option.isNone(article)) {
```
(later uses of `article` in that block → `article.value`).

`handlers.ts` ~296 (`findArticle`):
```ts
const live = findArticle(deps.document, req.tweetId)
const member = scope === 'notInterested' || Option.isNone(live) ? false : isMember(live.value, scope)
```
`index.tsx` ~113 (`findArticle`; add `Option` to its `effect` import):
```ts
const article = findArticle(document, tweetId)
if (Option.isNone(article)) {
```
(later uses of `article` → `article.value`).

- [ ] **Step 4 — gate + commit.** `bunx vitest run src/core/clear/ src/entrypoints/overlay.content/` · `bun run typecheck` · `bunx oxlint src/core/clear/clearer.ts src/core/clear/clearer.test.ts src/entrypoints/overlay.content/handlers.ts src/entrypoints/overlay.content/index.tsx`.
```bash
git add src/core/clear/clearer.ts src/core/clear/clearer.test.ts src/entrypoints/overlay.content/handlers.ts src/entrypoints/overlay.content/index.tsx
git commit -m "refactor(clear): tweetIdOfArticle + findArticle return Option

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: `findNotInterestedItem` + `findFeedbackButton` → Option

**Files:** `src/core/clear/clearer.ts`; callers `src/entrypoints/overlay.content/index.tsx` (~207, 248); test `src/core/clear/clearer.test.ts`.

- [ ] **Step 1 — update the tests (watch them fail).** Wrap the existing assertions with `Option.getOrNull`, e.g.:

```ts
it('findNotInterestedItem: matches the post item by English text', () => {
  const menu = document.createElement('div')
  menu.setAttribute('role', 'menu')
  menu.innerHTML = `
    <div role="menuitem">Follow @alice</div>
    <div role="menuitem">Not interested in this post</div>
    <div role="menuitem">Mute @alice</div>`
  expect(Option.getOrNull(findNotInterestedItem(menu))?.textContent?.trim()).toBe('Not interested in this post')
})
it('findNotInterestedItem: none when neither text nor icon matches (fail-safe)', () => {
  expect(Option.getOrNull(findNotInterestedItem(document.createElement('div')))).toBe(null)
})
```
For `findFeedbackButton`, wrap each call site the same way: `Option.getOrNull(findFeedbackButton(...))?.textContent` and `expect(Option.getOrNull(findFeedbackButton(...))).toBe(null)`. Run `bunx vitest run src/core/clear/clearer.test.ts` → FAIL.

- [ ] **Step 2 — convert both functions** in `clearer.ts`:

```ts
export function findNotInterestedItem(menuRoot: ParentNode): Option.Option<HTMLElement> {
  const items = [...menuRoot.querySelectorAll<HTMLElement>('[role="menuitem"]')]
  const byText = items.find((el) => /not interested in this post/i.test(elementText(el)))
  if (byText !== undefined) return Option.some(byText)
  const byIcon = items.find((el) =>
    [...el.querySelectorAll('svg path')].some((p) => NOT_INTERESTED_ICON.test(p.getAttribute('d') ?? '')),
  )
  return Option.fromNullable(byIcon)
}

export function findFeedbackButton(cell: Element): Option.Option<HTMLElement> {
  const outside = [...cell.querySelectorAll<HTMLElement>('button,[role="button"]')].filter(
    (b) => b.closest(TWEET_ARTICLE_SEL) === null,
  )
  const byPost = outside.find((b) => POST_NOT_RELEVANT_TEXT.test(elementText(b)))
  if (byPost !== undefined) return Option.some(byPost)
  const byFewer = outside.find((b) => SHOW_FEWER_TEXT.test(elementText(b)))
  if (byFewer !== undefined) return Option.some(byFewer)
  const positional = outside.length >= 3 ? outside[2] : outside.length >= 2 ? outside[1] : undefined
  return positional !== undefined && !UNDO_TEXT.test(elementText(positional))
    ? Option.some(positional)
    : Option.none()
}
```

- [ ] **Step 3 — update callers** in `index.tsx`.

~207 (`findNotInterestedItem`, assigned to a `let item: HTMLElement | null`):
```ts
if (sole) item = Option.getOrNull(findNotInterestedItem(sole))
```
~248 (`findFeedbackButton`):
```ts
const fb = findFeedbackButton(cell)
if (Option.isSome(fb)) {
```
(later uses of `fb` in that block → `fb.value`).

- [ ] **Step 4 — gate + commit.** `bunx vitest run src/core/clear/ src/entrypoints/overlay.content/` · `bun run typecheck` · `bunx oxlint src/core/clear/clearer.ts src/core/clear/clearer.test.ts src/entrypoints/overlay.content/index.tsx`.
```bash
git add src/core/clear/clearer.ts src/core/clear/clearer.test.ts src/entrypoints/overlay.content/index.tsx
git commit -m "refactor(clear): findNotInterestedItem + findFeedbackButton return Option

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Declined conversions (evidence-based)

These were audited and **deliberately left `T | null`**. Converting them is net-negative — it adds ceremony, `.value!` assertions, or `getOrElse(() => null)` round-trips back to null at the Preact/DOM boundary, contradicting spec §3 (keep DOM/React/hot-path nullables raw).

- **The `adapters/x` DOM→MediaItem resolve chain** — `resolveImageElement`, `resolveTweetContext`, `contextFromArticle`, `contextFromPath`, `linkContext`, `resolveHoverItem`, `detectRenderedImageElements` (`src/core/adapters/x/index.ts`). These are one tightly-coupled chain feeding the overlay hot path. Converting forces nested `Option.match` over today's clean `?.index ?? …` / `?? contextFromPath(…)`, an `out.push(item.value!)` non-null assertion in `detectRenderedImageElements`, and ~30 test-assertion edits — for no external safety gain (the `.tsx` consumers immediately unwrap). Revisit only if the overlay adopts `Option` end-to-end (a larger, separate decision).
- **`mediaKeyFromUrl`** (`src/core/adapters/x/dom.ts`) — a low-level primitive with 5 callers (incl. a hot dedup loop and `.tsx`) entangled with the declined chain above. Keep raw per spec §3 ("pervasive utility / hot path").
- **`videoPosterUrl`** (`src/core/adapters/x/dom.ts`) — both callers do `Option.getOrElse(…, () => null)`, immediately round-tripping back to null. Pure churn.

## Keep-nullable (correct as-is)

`clearControl`, `ownControl`, `caretControl`, `cellOf` (private one-shot DOM guards); `classifyFunctionMessage` (private, single internal `!== undefined` caller); `findScreenName`, `playerPosterUrl`, `videoTweetsNeedingRecovery`, `detectFromJson` (JSON walkers / tight loops with immediate `??`/guard consumption).

## Self-review

- **Spec coverage:** every in-scope §3 "to-Option domain resolver" with a clean guard caller has a task (1–6). Declined/keep-nullable items are enumerated with rationale — no silent omissions.
- **Placeholder scan:** every step shows exact before/after code for the function, its callers, and its tests.
- **Type consistency:** all converted functions return `Option.Option<T>`; callers use `Option.isNone`/`.value`/`Option.getOrElse`; tests use `Option.getOrNull`. `clearableScope` intentionally keeps `ClearScope | null` (bounds ripple) via `Option.getOrElse`. `findArticle` depends on `tweetIdOfArticle` — converted together in Task 5.
- **Caller completeness:** caller lists came from grepping each identifier across `.ts` AND `.tsx` (the pilot proved `.ts`-only misses `.tsx`); `bun run typecheck` in every task is the backstop that catches any missed site.

## Execution handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-30-monadic-style-phase4-option-layer.md`. Two execution options:**

**1. Subagent-driven (recommended)** — fresh subagent per task, two-stage review between tasks.

**2. Inline execution** — batch with checkpoints via executing-plans.

**Which approach?**
