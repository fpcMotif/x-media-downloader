# 011 — Extension Accessibility (a11y) & Sizing Hardening

- **Status**: IN PROGRESS
- **Severity**: MEDIUM
- **Category**: Accessibility
- **Target**: Extension Popup, Options Page, and Overlay controls

## Problem

1. Screen readers fail to announce setting save status in Popup and Options because `<div aria-live="polite">` contains static text nodes whose visibility is only toggled by CSS opacity (`opacity-0` vs `opacity-100`).
2. Plan 008 was reverted because `width: min(380px, 100vw)` collapsed the Chrome extension action popup bubble. A bubble-safe 320px reflow solution is needed that does not use `100vw` on root elements.
3. Form controls and navigation landmarks require verified ARIA attributes (`role="status"`, `aria-atomic="true"`, `aria-live="polite"`, `aria-labelledby`).

## Target

1. Update `src/entrypoints/popup/App.tsx` and `src/entrypoints/options/App.tsx` live regions to:
   - Add `role="status"` and `aria-atomic="true"`.
   - Conditionally render the message content `{saved && (...)}` so DOM node insertion triggers screen reader announcements.
2. Update `src/app.css`, `src/entrypoints/popup/index.html`, and `src/entrypoints/popup/popup-layout.test.ts` to support 320px responsive popup reflow without root `100vw` collapse.
3. Add/update tests in `App.test.ts` and `popup-layout.test.ts` to lock in accessibility contracts.

## Verification

- `bun run test`
- `bun run typecheck`
- `bun run lint`
- `agent-browser --cdp 9222` verification
