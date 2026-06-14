# Task 006 (impl): Content-script wiring (arm + clearFromList handler)

- **Type:** impl
- **depends-on:** ["002-impl", "004-impl", "005-impl"]
- **Files:** `src/entrypoints/overlay.content/index.tsx` (content script)

Integration glue in the content script. Mostly DOM/runtime wiring that can't be meaningfully unit-tested, so this task carries a **manual verification checklist** (mirrors the photo-badge plan's overlay task). The unit-testable pieces (surface match, control resolution, tally, coordinator) are already covered by tasks 004/005/001.

## Behavior contract (spec §3, §4)

- **Arm on Likes-page downloads only.** When the user triggers a download (badge / Quick Grab / Download-all) and `isLikesSurface(location.pathname)` is true and `autoUnlikeOnSave` is on, include the `tweetId` + the item set so the background can `arm` the coordinator. (Pass through the existing `sendTracked` / download message path — add the surface flag + tweetId grouping; do not create a second message channel.)
- **Handle `clearFromList`.** Add a runtime message listener: on `{ type:'clearFromList', tweetId, unlike:true }`, call `clearFromList(tweetId, { unlike:true })` from `adapters/x/actions`.
- **Scroll-off (spec §4 default).** If the article for `tweetId` is not currently in the DOM, queue the `tweetId` and apply via a `MutationObserver` when it next enters the list; discard the queue on navigation away from the Likes surface.
- **Only user-downloaded posts / outer post / fire-once** are already enforced upstream (content arms only on a real download; `clearFromList` matches the outer article; the coordinator latches).

## BDD Scenario

```gherkin
Scenario: Likes-page download arms the tracker and un-likes on completion
  Given the user is on their Likes page with autoUnlikeOnSave on
  When they download all media of a liked post and every item confirms complete
  Then the post is un-liked and disappears from the Likes list
  And if any item fails the post stays liked
```

## Manual verification checklist (live X, logged in)

1. Settings: enable "Un-like after saving (Likes page)".
2. On `/{handle}/likes`, Download-all a liked **4-photo** post → after all 4 confirm, the post un-likes and drops off the list.
3. A **single-photo** liked post → un-likes after the one file lands.
4. Simulate a failure (e.g., offline mid-download) → post **stays liked** (partial-failure keep).
5. On `/i/bookmarks` and `/home`, the same download does **not** un-like anything (surface guard).
6. With the setting **off**, nothing is un-liked.
7. Scroll a large-video post off-screen before it finishes → it un-likes when scrolled back into view (or per the chosen scroll-off behavior).

## Verification

- `bun run test` — full suite green.
- `bun run check` — fmt + lint + typecheck + tests pass.
- Manual checklist above performed on live X.
