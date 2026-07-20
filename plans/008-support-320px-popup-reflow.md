# 008 — Support 320px popup reflow

- **Workflow**: improve-react
- **Status**: REVERTED — `min(380px, 100vw)` on the document shell collapses the real action-popup bubble to a sliver (`vw` in a bubble is the bubble's own initially-tiny viewport, not the window width). Landed, broke the bubble, reverted; the fixed 380px shell stays. A correct 320px reflow needs intrinsic-width content sizing, not viewport units, and a real bubble check.
- **Commit**: cf787c6
- **Severity**: MEDIUM
- **Category**: Accessibility
- **Rule**: Beyond the scan
- **Estimated scope**: 3 files, about 35 lines

## Problem

The responsive child is defeated by a fixed root minimum:

```css
/* src/app.css:143 — current */
html,
body,
#app {
  width: 380px;
  min-width: 380px;
}

.xmd-popup {
  width: min(380px, 100vw);
}
```

`src/entrypoints/popup/index.html:7-21` repeats the fixed root and fallback
width before hydration. At 320 CSS px, the page can clip or scroll sideways.
`popup-layout.test.ts:34-43` currently pins the fixed minimum.

## Target

Use this exact root rule in both the main CSS and inline boot CSS:

```css
html,
body,
#app {
  width: min(380px, 100vw);
  min-width: 0;
  margin: 0;
  background: var(--xmd-bg);
}
```

In `index.html`, keep its literal boot background `#f8f9fb` instead of the CSS
variable. Keep `.xmd-popup { width: min(380px, 100vw); }`. Change only the boot
fallback width:

```css
.xmd-boot-fallback {
  box-sizing: border-box;
  width: 100%;
  min-height: 360px;
  /* current remaining declarations */
}
```

Normal browser-action width stays 380 px. A narrower viewport caps it at 100vw.

## Repo conventions to follow

- Keep hydrated and pre-hydration sizing mirrored between `app.css` and
  `popup/index.html`.
- Update the source-contract assertions in `popup-layout.test.ts:21-52`.
- Preserve the content-driven height rules documented beside `.xmd-popup`.

## Steps

1. Replace the fixed root width/minimum in `src/app.css`.
2. Mirror it in `src/entrypoints/popup/index.html`.
3. Set boot fallback width to 100%.
4. Update `popup-layout.test.ts` to require responsive width, `min-width: 0`,
   no `min-width: 380px`, matching boot CSS, and fallback width 100%.
5. Re-read the diff. No typography or height change.

## Boundaries

- Popup width only.
- Preserve the 360 px minimum and 600 px maximum heights.
- Do NOT change options layout, typography, spacing, or breakpoints.
- Add no dependency.
- STOP if code differs from `cf787c6`; reconcile first.

## Verification

- **Mechanical**:
  - `bun run test -- src/entrypoints/popup/popup-layout.test.ts`
  - `bun run typecheck`
  - `bun run lint`
  - `bun run build`
  - `npx --yes react-doctor@latest . --scope changed` adds no issue and lowers no score.
- **Behavior check**: Open the popup document at 320 CSS px. Confirm
  `document.documentElement.scrollWidth <= document.documentElement.clientWidth`,
  no horizontal scroll, and all text/actions remain visible. Confirm normal width
  is 380 px and loading/hydrated frames match. Repeat at 400% zoom.
- **Done when**: the popup reflows at 320 px without horizontal loss, normal
  sizing and height stay unchanged, and all checks pass.

