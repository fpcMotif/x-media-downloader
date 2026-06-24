# Sensitive-content reveal — live selector probe

`src/core/adapters/x/reveal.ts` locates X's "Content warning" reveal control with
selectors that are X's one brittle surface (no stable `data-testid`; localized
label). This probe confirms those selectors against the live DOM. Run it in the
**x.com DevTools console** on a page that shows at least one sensitive cover.

If the probe's findings disagree with what `findSensitiveRevealControls` would
match, adjust the three constants in `reveal.ts` (`PHOTO_COVER_CONTAINER_SEL`,
`REVEAL_LABELS`, `REVEAL_SCOPE_SEL`) and update `reveal.test.ts` to match.

Note: every candidate is then run through `isOffLimits`, which drops anything in
a video context (`[data-testid="videoPlayer"]`/`videoComponent`, or wrapping a
`<video>`), the `ALT` badge, icon-only controls (an aria-label/SVG with no worded
label), and aria-labelled playback/expand controls. The video-context rule is a
hard guarantee: auto-reveal never clicks inside a video player, so it can't play
or fullscreen a video — which means a *video* cover is intentionally NOT
auto-revealed (the GraphQL tee still captures sensitive videos for download). If a
real worded *photo* reveal stops firing, confirm it isn't being caught by that
guard (e.g. X made the cover button icon-only).

```js
;(() => {
  const isBtn = (el) => el.tagName === 'BUTTON' || el.getAttribute('role') === 'button'
  const text = (el) => (el.textContent ?? '').trim().slice(0, 40)

  // 1. Buttons inside a photo cover container (locale-independent path).
  const photoBtns = [...document.querySelectorAll('[data-testid="tweetPhoto"] [role="button"], [data-testid="tweetPhoto"] button')]
  console.log('photo-container buttons:', photoBtns.length)
  photoBtns.forEach((b) => console.log('  ', b.tagName, '| aria:', b.getAttribute('aria-label'), '| text:', JSON.stringify(text(b))))

  // 2. Every role=button whose text looks like a reveal label (label path).
  const labelBtns = [...document.querySelectorAll('[role="button"], button')]
    .filter(isBtn)
    .filter((b) => ['Show', 'View'].includes(text(b)))
  console.log('reveal-labelled buttons:', labelBtns.length)
  labelBtns.forEach((b) =>
    console.log('  text:', JSON.stringify(text(b)),
      '| in article/dialog:', b.closest('article, [role="dialog"], [aria-modal="true"]') !== null,
      '| container testid:', b.closest('[data-testid]')?.getAttribute('data-testid')),
  )

  // 3. The cover markup, to eyeball nesting (container vs sibling, label, icon).
  const cover = document.querySelector('[data-testid="tweetPhoto"] [role="button"], [data-testid="videoPlayer"] [role="button"]')
  if (cover) console.log('sample cover outerHTML:\n', cover.closest('[data-testid]')?.outerHTML.slice(0, 600))
})()
```

Expected on a healthy match:

- **photo-container buttons** lists the reveal button (text `"Show"`/`"View"`),
  and does _not_ list an `ALT` badge or a media control (those are filtered in
  `isNonRevealPhotoButton`).
- **reveal-labelled buttons** each report `in article/dialog: true`.
- The sample `outerHTML` shows the reveal control nested under the media
  container; if instead the cover is a **sibling/overlay** of `tweetPhoto`, the
  label path (2) still catches it — but note it so the selectors stay honest.

For a non-English UI, add the localized reveal label (whatever text the button
shows) to `REVEAL_LABELS`.
