# For You "Not interested" clear — smoke + e2e test plan

Validates the timeline clear-on-complete feature (fire X's "Not interested in this
post" on the For You feed) and the **full-post gate** (a 1-of-4 grab must never hide
the post). The pure logic has 100% unit coverage in happy-dom; this plan adds
**real-Chromium** execution + **live-x.com ground-truth** validation of the DOM
selectors — the documented manual/e2e gap.

## Coverage strategy — 4 injection angles

| # | Angle | What it proves | Where |
|---|---|---|---|
| 1 | **Static X-DOM fixtures** | `clearer.ts` selectors resolve correctly against realistic X markup, run in a real browser (not happy-dom) | injected suite, any page |
| 2 | **Live x.com ground truth** | the real `data-testid="caret"`, the real "Not interested in this post" menu item, the real For-You tab text/structure match my selectors | live x.com (read-only — never click "Not interested") |
| 3 | **Full-post gate (ledger)** | seeding `expected` = full post blocks the clear until every photo lands; 1-of-4 never fires | injected `ledger.ts` |
| 4 | **Menu-linkage algorithm** | the snapshot-diff only acts on the menu our caret opened; ambiguous → bail | injected suite |

## Smoke cases (must all pass)

### A. For-You detection (`isForYouHome` / `clearableScope`)
- A1 `/home` + "For you" tab `aria-selected=true` → `isForYouHome=true`, `clearableScope='notInterested'`
- A2 `/home` + "Following" selected → `false` / `null` (negative signal never on Following)
- A3 off `/home` (`/explore`, profile, `/search`) → `false` / `null`
- A4 localized tab ("Pour vous") → `false` (fail-safe inert, never wrong feed)
- A5 `pageScope('/home')` stays `null` (timeline is not a list page; manual buttons untouched)
- A6 `/i/bookmarks`→`bookmark`, `/u/likes`→`like` (membership pages unchanged)

### B. Caret menu (`caretControl` / `findNotInterestedItem` / `notInterestedConfirmed`)
- B1 `caretControl` finds the article's OWN `[data-testid="caret"]`, ignores a quoted-card caret
- B2 `findNotInterestedItem` finds "Not interested in this post" among real menu items
- B3 `findNotInterestedItem` returns `null` for a "Not interested in this **topic**" only menu (no broader action)
- B4 `findNotInterestedItem` returns `null` when absent (selector rot ⇒ inert, not wrong)
- B5 `notInterestedConfirmed`: `false` intact, `true` on caret-gone (collapsed), `true` on detached
- B6 `tweetIdOfArticle` resolves the OUTER permalink, ignores quoted `/status/` links

### C. Full-post gate (`ledger.isTrulyComplete`)
- C1 expected=[m0..m3], settle only m0 → **not** truly complete (the 1-of-4 safety: post stays)
- C2 settle all 4 → truly complete (clear may fire) → `canClaim('notInterested')` true
- C3 settle 3, m3 fails → not truly complete (one un-landed byte vetoes the hide)
- C4 single-photo post (expected=[m0]), settle m0 → truly complete (whole post = clears)

### D. Menu-linkage (wrong-target guard)
- D1 a stale menu already open; caret click opens a new menu → snapshot-diff selects the NEW menu only
- D2 two new menus appear → ambiguous → bail (no item, never guess)

### E. Live x.com ground truth (read-only)
- E1 on x.com/home `isForYouHome` agrees with the visibly-selected tab
- E2 a real tweet's `tweetIdOfArticle` matches the permalink in the URL/DOM
- E3 a real `[data-testid="caret"]` exists and opens a `[role="menu"]`
- E4 that menu **contains** a "Not interested in this post" item (verify text only — DO NOT click)
- E5 Escape closes the menu (cleanup path works)

## Hard safety rule for live testing
Never click "Not interested" / un-bookmark / un-like on the real account. Live angle
is **read-only**: resolve selectors, open+inspect+Escape the caret menu, assert the
item EXISTS. Destructive verification happens only on synthetic fixtures.

## Fix loop
Run angles 1/3/4 (injected suite) → run angle 2 (live probe) → any selector that
disagrees with live X is a real bug in `clearer.ts` → fix → rebuild bundle → re-run.

## Results — 2026-06-21 (run against the user's live, logged-in x.com)

Harness: `bun build` of `clearer.ts`/`ledger.ts` → IIFE bundles, served on
`localhost:8731`, driven through Claude-in-Chrome (`mcp__Claude_in_Chrome__*`).

- **Angles 1/3/4 (fixtures, gate, menu-linkage): 29/29 pass** in real Chromium.
- **Angle 2 (live x.com) found a SEV-HIGH bug:** the account's X UI is **Traditional
  Chinese**, so:
  - `isForYouHome` returned **false** — the For-You tab reads **"為你推薦"**, which the
    old `/^for you$/i` match could not see → the whole feature was **silently inert**.
  - The "Not interested" menu item is **"對此貼文不感興趣"** with **no `data-testid`** →
    the old English-text `findNotInterestedItem` returned **null** → clear never fired.
  - Confirmed-correct against live X: `caret` testid, `[role=menu]`/`[role=menuitem]`
    structure, `tweetIdOfArticle`, `bookmark`/`removeBookmark` testids.

- **Fix (locale-independent anchors):**
  - `isForYouHome` → **position**: on `/home`, the selected tab is index 0 of the home
    tablist (For You is always first; Following is index 1). Live `selectedIndex: 0`. ✓
  - `findNotInterestedItem` → **icon**: match the not-interested frowning-face SVG path
    (`/^M12 13\.6c1\.64/`), with the English text kept as a fast path. The icon is
    unique to this action (never Mute/Block/Report), so it is safe and locale-complete.
  - **Re-validated on live X:** `isForYouHome → true`, caret menu opens,
    `findNotInterestedItem → "對此貼文不感興趣"`. ✓

- **Not verified on live (deliberate):** the actual "Not interested" *click* + post
  collapse — never fired on the real account (irreversible). Covered by fixtures; the
  confirm path is fail-safe (no detected collapse ⇒ never marks cleared).

## Follow-up — full-hide of the cleared post (2026-06-21)

The "Not interested" click leaves a feedback stub on the feed ("Thanks. X will use
this…" + Show fewer / This post isn't relevant). Adopted `../xtimelinefilter`'s
live-verified approach to make the cleared post fully vanish:
- `clearNotInterested` now clicks the **post-level follow-up dismiss**
  (`findFeedbackButton`: isn't-relevant → show-fewer → positional, never Undo) so X
  drops the post natively.
- A **content-based stub collapser** (`collapseClearedStubs` + page CSS
  `[data-xmd-cleared] > * { display:none }`, observer-driven) hides any residual
  stub. Recycling-safe: a cell recycled to a real post stops matching `isClearedStub`
  and reappears. Gated on `clearOnSave && autoNotInterestedOnSave`.
- The stub matchers (Undo / show-fewer / isn't-relevant) are the multilingual regexes
  from `../xtimelinefilter`'s **live-verified** selectors (zh-Hant: 復原 / 減少顯示 /
  這是不相關的貼文), and the `NOT_INTERESTED` icon prefix matches theirs exactly.

Validation: **35/35** browser fixtures (adds E1–E6: feedback-button priority, stub
detection through the whole feedback flow, recycling-safe collapse). Live read-only:
`cellInnerDiv` wrapping confirmed (`cellOf` resolves real cells); no stub was present
to inspect (the prior one was already gone post-reload), so end-to-end *firing* of the
dismiss+collapse was NOT executed on the live account (irreversible) — fixture-covered.

### Reproduce
```
bunx esbuild src/core/clear/clearer.ts --bundle --format=iife --global-name=CLEARER --outfile=/tmp/xmd-e2e/clearer.iife.js
bunx esbuild src/core/clear/ledger.ts  --bundle --format=iife --global-name=LEDGER  --outfile=/tmp/xmd-e2e/ledger.iife.js
cd /tmp/xmd-e2e && python3 -m http.server 8731   # harness.html + suite.js live here
# Claude-in-Chrome → navigate localhost:8731/harness.html → read window.__XMD__
```
