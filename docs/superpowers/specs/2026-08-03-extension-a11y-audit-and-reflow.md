# Extension Accessibility (a11y) & Sizing Hardening Spec

**Date:** 2026-08-03
**Status:** PROPOSED / IN IMPLEMENTATION
**Target:** Extension Popup, Options Page, and Overlay controls

---

## 1. Problem Statement

An accessibility audit using `agent-browser` CDP automation and WCAG AA guidelines identified key accessibility gaps across the extension interface:

1. **Save Status Toast Announcements**:
   - In both `src/entrypoints/popup/App.tsx` and `src/entrypoints/options/App.tsx`, the save feedback toast uses `<div aria-live="polite">` with static child text (`Saved` or `All changes saved`). Because the text node is mounted at page boot and only visual CSS opacity changes when settings update, screen readers (VoiceOver, NVDA, JAWS) do not detect a DOM text insertion and fail to announce when settings are saved.
2. **320px Popup Responsive Reflow (Bubble Safe)**:
   - Plan 008 was reverted because applying `width: min(380px, 100vw)` to `html, body, #app` collapsed the Chrome action popup bubble (`100vw` in an un-sized extension action popup bubble evaluates to an initially tiny width). The popup requires responsive reflow down to 320px without using root viewport units (`100vw`) that collapse the extension bubble frame.
3. **Form Controls & ARIA Landmarking**:
   - All interactive controls across Popup and Options must maintain proper ARIA states (`role="status"`, `aria-atomic="true"`, `aria-live="polite"`), explicit programmatic labelling, and keyboard focus visibility.

---

## 2. Requirements & Architecture

### 2.1 Live-Region Toast Announcements (Popup & Options)
- In `src/entrypoints/popup/App.tsx` and `src/entrypoints/options/App.tsx`:
  - Provide a dedicated status element with `role="status"`, `aria-live="polite"`, and `aria-atomic="true"`.
  - Conditionally mount the inner text `{saved && (<span>Saved</span>)}` / `{saved && (<span>All changes saved</span>)}` so that DOM text insertions occur whenever `saved` transitions to `true`, triggering reliable screen reader speech output.

### 2.2 Responsive 320px Popup Layout
- In `src/app.css` and `src/entrypoints/popup/index.html`:
  - Maintain root `width: 380px` for standard Chrome extension popup action bubble container compatibility.
  - On `.xmd-popup`, set `max-width: 100%`, `min-width: 320px`, `box-sizing: border-box`, and `overflow-x: hidden`.
  - Ensure all layout containers, cards, and buttons within the popup wrap or scale gracefully down to 320px without horizontal scrollbars or clipping.

### 2.3 Verification & Quality Gate
- Unit/Component tests in `App.test.ts` and `popup-layout.test.ts` pinning:
  - Conditionally rendered toast text in `aria-live` status regions.
  - 320px reflow and CSS constraints without `min(380px, 100vw)` collapsing rules.
- Typechecking (`bun run typecheck`), linting (`bun run lint`), and full test suite (`bun run test`).
- CDP verification using `agent-browser --cdp 9222`.

---
