# 011 — Extension Accessibility (a11y) & Sizing Hardening

- **Status**: DONE
- **Severity**: MEDIUM
- **Category**: Accessibility
- **Target**: Extension Popup, Options Page, and Overlay controls

## Problem

1. Screen readers fail to announce setting save status in Popup and Options because live region elements contained static text nodes or were conditionally mounted only when text appeared.
2. Plan 008 was reverted because percentage/viewport widths on root elements collapsed the Chrome extension action popup bubble.
3. Form controls carried conflicting `aria-label` overrides that differed from visual `<FieldLabel htmlFor="...">` text, violating WCAG 2.5.3 (Label in Name).

## Target

1. Update `src/entrypoints/popup/App.tsx`, `src/entrypoints/options/App.tsx`, `archive.tsx`, `release.tsx`, `capture-quick-actions.tsx`, and `confirm-strip.tsx` live regions to:
   - Use semantic `<output aria-live="polite" aria-atomic="true">` elements continuously mounted in the DOM across all component states.
   - Conditionally render only inner text node content (`{saved && <span>Saved</span>}`, `{statusMsg}`) for empty-to-text mutation announcements without invalid block-element nesting.
2. Maintain explicit `width: 380px; min-width: 380px;` on root `html, body, #app` for Chrome action popup bubble safety. 320px popup reflow remains explicitly unsupported and reverted (per Plan 008), while Options page (`options.html`) supports responsive flex stacking (`flex-col sm:flex-row`) down to 320px.
3. Remove redundant/conflicting `aria-label` overrides across all options panel controls (`saving.tsx`, `capture.tsx`, `history.tsx`, `release.tsx`, `sync.tsx`) to ensure visual text matches accessible names (WCAG 2.5.3).
4. Add/update tests in `App.test.ts`, `popup-layout.test.ts`, and `confirm-strip.test.ts` to lock in accessibility contracts.

## Verification

- `bun run test` (142 test files, 2239 unit tests pass)
- `bun run typecheck`
- `bun run lint`
- `bun run build`
- CDP port 9222 axe-core v4.10.2 automated audit under strict DOM hydration readiness (`Strict Readiness Verified: true`): 0 violations, 0 incomplete items across all WCAG 2.0 A, 2.0 AA, 2.1 A, 2.1 AA, and 2.2 AA rules on options.html (235 DOM elements) and popup.html (52 DOM elements).
