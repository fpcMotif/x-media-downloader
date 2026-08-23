# Spec: Instagram/Threads media becomes undownloadable after an in-page route change

## Problem Statement

On Instagram (and Threads), some posts simply cannot be downloaded. Hovering the
video shows no hover badge, and Quick Grab charges its ring and then does
nothing. Other posts on the same page, in the same session, download fine — so it
reads as "this one post is special/broken", and the user reasonably suspects the
post itself is some unusual embed.

The post is not special. What differs is **when** its media data arrived relative
to the last in-page navigation.

Instagram is a single-page app. Scrolling from one reel to the next, opening a
post from the feed, and moving between tabs all change the URL **without loading
a new document**. On every one of those route changes the extension throws away
its entire **Detected Media Set**. Any post whose **Capture** arrived *before*
that route change is then permanently unresolvable: Instagram already has the
data client-side and never re-requests it, so **Passive capture** never sees it
again, and the extension has no way to recover it.

The result is arbitrary from the user's point of view. A reel opened by a direct
URL works. The same reel scrolled to inside the reels player does not. Reloading
the page fixes it. Nothing in the UI explains why.

### Evidence (live, this session)

Diagnosed against a live logged-in Chrome over CDP (port 9222), extension build
`0.1.0 build 2026-08-17`, on the user's reported post
`https://www.instagram.com/reel/DcV75F4ys05/`.

1. **The post is ordinary.** Its node in Instagram's own payload is
   `media_type: 2`, `product_type: "clips"`, three `video_versions[]`, a normal
   `image_versions2.candidates[]`, no `carousel_media`, `clips_attribution_info:
   null`, not a repost, no `media_overlay_info`, served from
   `scontent-*.cdninstagram.com`. It passes the CDN allow-list unmodified.

2. **Detection works.** The repository's own `detectMediaItems` /
   `postCodesInResponse` were bundled and executed against the live page: they
   extract one video **Media Item** and register the post code, producing exactly
   the keys hover resolution queries — `post:code:DcV75F4ys05`,
   `post:code:DcV75F4ys05:0`, `post:code:DcV75F4ys05:slot:0`.

3. **The full hover chain works** on a freshly loaded permalink. Running the real
   `resolveHoverMedia` → `previewKeyFromMedia` → `resolveHoverItem` against the
   live DOM at the video's centre returns the correct video Media Item
   (`teed: true`, `canResolve: true`).

4. **A route change destroys it.** Driving the live extension on a fresh load of
   the reel and reading the Bulk count out of the Overlay's shadow DOM:

   | step | URL | Bulk count |
   |---|---|---|
   | fresh load | `/reels/DcV75F4ys05/` | 19 → 23 |
   | ArrowDown (next reel) | `/reels/DcQedLDqVpf/` | **gone** |
   | ArrowUp (back to the original) | `/reels/DcV75F4ys05/` | **gone** |
   | hover the video | `/reels/DcV75F4ys05/` | no badge |

   The **Overlay stays mounted and alive** across all of this
   (`overlayAlive: true`), so this is not an orphaned content script. Only the
   Detected Media Set is gone, and it does not come back.

5. **The live trace matches the user's report exactly.** The user's own failing
   attempt recorded `quickgrab armed · key post:code:DcV75F4ys05` immediately
   followed by `quickgrab no-item-for-hover · not-teed video` — the post code was
   derived correctly from the DOM, and the store simply had nothing under it.

### Root cause

`store.clear()` on `wxt:locationchange` (`src/entrypoints/overlay.content/index.tsx`).

That one call exists for a real, X-only reason recorded in its comment: "Download
this page" must never inherit media detected on a previous SPA route, or visiting
Tweet Detail/Likes before Bookmarks makes **Release** enqueue stale posts against
the Bookmarks drain. That requirement is legitimate and unchanged by this spec.

The defect is that the same call also destroys the **hover-resolution index** —
the Media Key → Media Item map and the post-code ↔ post-id linkage — which is
keyed by post identity and is inherently route-independent. Nothing about a route
change makes a previously captured Media Item wrong; it only makes it
out-of-scope for a *page-level* action.

A second, smaller contributor: the inline server-embedded payload replay is a
one-shot at content-script boot. It is the only path by which server-rendered
Captures ever enter the store, and it never runs again, so a reset can never be
recovered from even when the data is still sitting in the document.

## Solution

Stop discarding what hover resolution needs.

On an in-page route change, the extension keeps the **Detected Media Set**'s
identity index — every Media Item it has already captured, addressable by its
Media Key and by its post code — and resets only the **page-action scope**: the
set of Media Items that "Download this page" (Bulk) and **Release** operate on.

Hovering a post whose Capture arrived at any point in the session resolves and
downloads, regardless of how many in-page navigations have happened since. The
Bulk count and Release enqueue set continue to mean exactly what they mean today:
media belonging to the route the user is currently on.

Additionally, the existing inline server-embedded payload replay runs again on a
route change, through the same Capture channel it already uses, so a document
whose data only ever existed as server-rendered content re-seeds itself instead
of being lost the first time the user navigates within the page.

Retention is bounded: the retained identity index has a ceiling, evicting
oldest-first, so an unbounded reels scroll cannot grow it without limit.

X behaviour — Release, Drain, the For You clear gate, Bulk's meaning — is
unchanged.

## User Stories

1. As an Instagram user scrolling the reels player, I want the reel currently on
   screen to be downloadable, so that the feature works where reels are actually
   watched.
2. As an Instagram user who scrolled past a reel and came back to it, I want it
   to still be downloadable, so that navigation history does not silently disable
   the extension.
3. As an Instagram user who opened a post from the home feed, I want that post's
   media to be downloadable, so that the ordinary way of opening a post is
   supported.
4. As an Instagram user, I want a post that was downloadable a moment ago to stay
   downloadable, so that the affordance does not disappear without explanation.
5. As a Threads user, I want the same guarantee on Threads' in-page navigation,
   so that both Meta platforms behave identically.
6. As a user, I want the hover badge to appear on any post whose media the
   extension has captured this session, so that "no badge" reliably means "not
   captured" and nothing else.
7. As a user holding the Quick Grab modifier, I want the ring to complete into a
   download rather than charging and dying, so that a charged ring is a promise.
8. As a user, I want whole-post Quick Grab (Alt + Cmd) to queue the whole post
   after an in-page navigation, so that the multi-slide path survives navigation
   too.
9. As a user of the `d d` hotkey on Meta, I want the post-code bridge to still
   resolve after an in-page navigation, so that the keyboard path is not a
   quiet no-op.
10. As a user, I want a directly-navigated permalink to keep working exactly as
    it does today, so that the fix does not regress the one path that already
    worked.
11. As a user on the Bulk dock, I want the count to reflect the media of the page
    I am on, so that "Download this page" does not silently include posts from a
    route I already left.
12. As an X user on Bookmarks, I want Release to enqueue only the posts of the
    list I am on, so that the existing route-scoping guarantee is preserved
    exactly.
13. As an X user moving from Tweet Detail to Likes to Bookmarks, I want no stale
    post from an earlier route to be enqueued against the current drain, so that
    the reason the wipe existed remains satisfied.
14. As a user who scrolls a reels player for a long session, I want the
    extension's retained identity index to stay bounded, so that a long session
    does not grow memory without limit.
15. As a user whose oldest captured media has been evicted by that bound, I want
    the extension to behave exactly as it does for never-captured media — no
    badge, no ring, no partial action — so that eviction is honest rather than
    broken.
16. As a user on a page whose media data is only ever server-embedded, I want it
    re-seeded after an in-page navigation, so that data still present in the
    document is not treated as lost.
17. As a user, I want the re-seed to be de-duplicated by Media Key, so that
    replaying the same document payload cannot double-count the Bulk total.
18. As a user, I want the re-seed to cost no extra network request, so that
    **Passive capture** stays passive.
19. As a user hovering media whose Capture genuinely never arrived, I want no
    badge and no ring, so that the extension never implies it can download
    something it cannot.
20. As a user, I want a post that becomes resolvable only after its Capture
    arrives to become downloadable at that moment without a page reload, so that
    late Captures still count.
21. As a user, I want an in-page navigation to still cancel an in-flight hover,
    ring, and badge, so that pre-navigation UI never re-arms against detached
    DOM.
22. As a user, I want an in-page navigation to still cancel armed Release
    re-check probes, so that no diagnostics are written about a route that no
    longer exists.
23. As a developer diagnosing a "nothing happens on hover" report, I want the
    existing `no-item-for-hover` trace to keep distinguishing "captured but
    unresolved" from "never captured", so that the discriminator that identified
    this bug stays available.
24. As a developer, I want a trace emitted when a route change resets the
    page-action scope, so that the reset is visible in evidence rather than
    inferred from a vanished count.
25. As a developer, I want a trace emitted when the server-embedded replay
    re-seeds after a route change, so that the re-seed can be confirmed live.
26. As a maintainer, I want the retained-versus-reset split to live in one place,
    so that a future surface cannot accidentally consume the wrong one.

## Implementation Decisions

- **Single seam: the Detection Store's route-change reset.** The Detection Store
  is already the sole owner of both the identity index (Media Key → Media Item,
  post code ↔ post id, per-post video index) and the collection that backs the
  Bulk count. The split therefore belongs inside it, and the Overlay's
  `wxt:locationchange` handler swaps one method call for another. No new module,
  no new event channel, no new **Source Adapter** field, no new content script.

- **Two distinct resets, named for their meaning.** The existing total wipe stays
  available and keeps its current semantics for the popup's "Find new media"
  rescan, which genuinely wants to drop everything. The route-change path calls a
  narrower reset that clears the page-action scope and retains the identity
  index. Naming makes the difference impossible to confuse at a call site.

- **What "page-action scope" contains.** The Media Items that Bulk counts and
  that Release enqueues. What survives a route change is everything hover
  resolution consumes: the Media Key index, the `post:code:*` keys, the post-code
  ↔ post-id linkage, and the recovered-key provenance that prevents a recovered
  item being double-counted when the tee later re-surfaces it.

- **Bounded retention.** The retained identity index carries an explicit ceiling,
  evicting oldest-first by insertion order, so an unbounded reels scroll cannot
  grow it without limit. Eviction is indistinguishable from never-captured: the
  key disappears, hover reports `not-teed`, and no partial action fires. The
  Detection Store's maps are already insertion-ordered, so eviction is a property
  of the existing structure rather than a new one.

- **Attempted-recovery claims reset with the page-action scope**, not with the
  identity index — a new route is a new opportunity to attempt Recovery for media
  the store still cannot see.

- **Inline replay becomes route-aware, not boot-only.** The existing replay
  already dispatches every candidate server-embedded payload through the same
  Capture event the network tee uses, so it goes through the identical, already
  tested parse → detect → register path. Running it again on a route change adds
  a call site, not a code path. It stays Instagram/Threads-only and issues no
  network request. Media Key de-duplication in the Detection Store already makes
  a repeat replay idempotent for identity; the page-action scope is re-seeded
  from it deliberately, because a server-embedded payload describes the document
  the user is currently in.

- **The Overlay's other route-change work is untouched.** Cancelling the hover
  sample, releasing the grab, resetting the badge, clearing the Meta focused
  post, cancelling armed Release re-check probes, and the pinned
  saved-status route read all keep their current behaviour and ordering. This
  spec changes one call in that handler and adds one.

- **X is unaffected by construction.** Release's page-scoping requirement is
  satisfied by resetting the page-action scope, which is what it actually
  depended on; it never consumed the identity index across routes. The retained
  index changes no X surface.

- **Diagnostics.** Two new trace stages — one for the route-change reset (naming
  what was retained and what was reset), one for the replay re-seed (naming how
  many payloads were re-ingested and how many Media Items landed). Both use the
  existing trace channel and are prod-visible, matching the posture that made
  this bug diagnosable at all: the existing `armed` → `no-item-for-hover ·
  not-teed video` pair is precisely what identified the root cause, and it is
  preserved unchanged.

## Testing Decisions

A good test here asserts externally observable behaviour: given a sequence of
Captures and route changes, what can the user resolve and download, and what does
the Bulk count say. It must not assert which internal map holds what, or how many
times a reset was called. The tests should read as the bug report does.

- **Detection Store (`src/core/adapters/detection-store.ts`) — primary.** Its
  co-located unit tests are the natural home and already exercise this exact
  surface. New cases, all through the public surface:
  - a video Capture, then a route-scope reset, then resolve by its `post:code:*`
    key — resolves (this is the regression test for the reported bug);
  - the same, resolving by plain Media Key — resolves;
  - the same, then the Bulk count — zero;
  - a post-code linkage registered before the reset still bridges to its post id
    after it;
  - a multi-video carousel's indexed and dom-slot keys survive the reset;
  - the total wipe still clears everything, so the rescan path is unchanged;
  - retention past the ceiling evicts oldest-first, and an evicted key resolves
    to nothing rather than to a wrong item;
  - attempted-recovery claims are released by the route-scope reset.
  Prior art: the existing `detection-store.test.ts` cases covering
  `syncPostVideoKey`'s bare/indexed/slot key registration and the
  `registerPostCode`-before-`addDetected` order independence.

- **Overlay route-change handler (`src/entrypoints/overlay.content/`).** One
  behavioural test that a route change resets the page-action scope and keeps
  hover resolvable, and one that the server-embedded replay is dispatched again
  on that event. Prior art: the existing overlay tests that assert against the
  `xmd:media-response` event boundary rather than against internals — the replay
  is already observable there.

- **Inline payload replay (`src/core/adapters/meta-shared/inline-data.ts`).**
  Already pure and covered; no new tests beyond confirming a repeat replay of the
  identical payload set adds no duplicate Media Items, asserted through the
  Detection Store's count.

- **No new live-browser dependency.** The live CDP session that produced the
  evidence above is reproducible but is not a test; the behaviours it revealed
  are all expressible at the two seams above. The 100% coverage gate over
  `src/core` and `src/lib` applies as usual.

## Out of Scope

- **Re-fetching lost Captures.** The extension stays passive. If a Capture never
  arrived, or was evicted by the retention ceiling, the answer is still "no
  badge" — never a new network request.
- **A MutationObserver for late-inserted server-embedded payloads.** Live timing
  measurement showed the reel's payload present in the document well before the
  content script's replay (inserted at ~1.2 s, replayed at ~1.75 s, page load at
  ~1.7 s), so late insertion is not a demonstrated failure mode. Adding an
  observer would be speculative.
- **The trace ring's capacity.** `MAX_TRACE_EVENTS` is 12, which is far too small
  to diagnose a hover failure in the field — during this investigation the ring
  was flushed by unrelated clear traces from other tabs within seconds, and the
  user's own failing evidence survived only by luck. Real, and worth fixing, but
  a separate concern from this defect.
- **The feed's video-versus-poster hover resolution.** One feed reel was observed
  where the hover badge offered "Download photo" over a `<video>` while the
  adapter chain resolved the video Media Item. Single observation, not
  reproduced, plausibly the poster `<img>` winning the hit test. Needs its own
  diagnosis rather than a guess folded in here.
- **Bulk semantics on an infinite scroller.** Whether "Download this page" should
  mean "the reel on screen" or "every reel scrolled past" is a product question
  this spec does not answer; it preserves today's answer (the current route).
- **X behaviour of any kind.**

## Further Notes

- The reason this reads as "one particular post is broken" is that whether a
  given post works is decided by an invisible race: posts whose Capture arrives
  in a network response *after* the last route change work; posts prefetched in
  an earlier batch, or server-rendered into the original document, do not. In the
  reels player Instagram prefetches several reels in one batched response and
  then changes the URL as the user scrolls, which puts the *currently watched*
  reel on the losing side of that race almost every time.
- Reloading the permalink is the existing workaround and explains why the post
  appears to fix itself intermittently.
- The diagnosis method is worth keeping: bundling the repository's real
  `detectMediaItems`, `DetectionStore`, adapter, and hover resolver into a page
  script and running them against the live DOM separated "does our logic work"
  from "does our lifecycle work" in one step. It proved the logic correct and
  localised the defect to the lifecycle, which no amount of reading either could
  have settled.
- Related open work: #90 (`d d` whole-post Quick Grab on Instagram/Threads)
  depends on the same post-code ↔ post-id bridge this spec stops destroying, and
  will be unreliable on any post-navigation page until this lands.
