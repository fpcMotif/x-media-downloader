# Lesson 0007: Accessibility Live Regions, Fixed Action Popup Sizing, and WCAG 2.5.3

**Date:** 2026-08-03
**Category:** Accessibility (a11y) & UI Architecture

---

## 1. Summary of Changes

### HTML and Component Architecture
- **Live Regions (`<output>`)**: Replaced conditional `<div aria-live="polite">` and `<p aria-live="polite">` containers with continuously mounted `<output aria-live="polite" aria-atomic="true">` elements across `App.tsx`, `archive.tsx`, `release.tsx`, `capture-quick-actions.tsx`, and `confirm-strip.tsx`.
- **ConfirmStrip React DOM Preservation**: Updated `confirm-strip.tsx` so the top-level return is wrapped in a `<>` Fragment, with a single `<output key="confirm-strip-output" aria-live="polite" aria-atomic="true" className="sr-only">{announceText}</output>` at index 0 outside the `{armedAt === null ? children(arm) : <div ...>...</div>}` conditional. React's keying algorithm preserves the exact same DOM node across idle and armed states, mutating `announceText` from `''` to ``Press ${confirmLabel} to continue, or Cancel.``.
- **Phrasing Content Validity**: Removed block-level `<FieldDescription>` (`<p>`) tags from inside `<output>` containers. Placed plain text or `<span>` nodes inside `<output>`.
- **Label Matching (WCAG 2.5.3)**: Removed redundant and conflicting `aria-label` overrides on controls in `saving.tsx`, `capture.tsx`, `history.tsx`, `release.tsx`, and `sync.tsx` where `<FieldLabel htmlFor="...">` already links the visual label to the control ID.

### CSS and Layout Architecture
- **Fixed Bubble-Safe Popup Shell**: Maintained explicit `width: 380px; min-width: 380px;` rules on root elements (`html, body, #app`) in `src/app.css` and `src/entrypoints/popup/index.html`. 320px popup reflow remains explicitly unsupported and reverted (per Plan 008) to prevent Chrome action popup bubble collapse.
- **Options Layout Reflow**: Added responsive breakpoint classes (`flex-col sm:flex-row`) in `src/entrypoints/options/App.tsx` so sidebar and main panels stack cleanly on narrow viewports down to 320px without horizontal scrolling.

---

## 2. Technical Analysis for Beginners

### A. Live Region Announcements & React Reconciliation (ConfirmStrip Precedent)
- **Why changing root node types destroys live regions**: If a component returns `<> <output /> </>` when idle but `<div ...> <output /> </div>` when armed, React's diffing algorithm unmounts the entire `<React.Fragment>` DOM tree (destroying the old `<output>` element) and mounts a brand-new `<div>` tree with a new `<output>` element created already containing text. Screen readers miss the announcement because the element was newly mounted with text rather than mutated from empty within a persistent region.
- **Why top-level keyed `<output>` is correct**: Wrapping the component in `<>` and placing `<output key="confirm-strip-output" ...>{announceText}</output>` outside the idle/armed conditional ensures React preserves the exact same `<output>` DOM node across state transitions. When `armedAt` changes, React mutates the text node inside the existing live region from `''` to ``Press ${confirmLabel}...``, triggering reliable speech output.
- **HTML semantics**: HTML rules prohibit block elements (`<p>`, `<div>`) inside phrasing elements (`<output>`). Replacing `<p>` with `<span>` or direct text node children ensures valid HTML parsing.

### B. Chrome Extension Action Popup Sizing (Plan 008 Context)
- **Why the root requires a fixed 380px width**: When Chrome opens an extension action popup bubble, it measures the un-sized iframe container. If the root element width depends on container percentages (`100vw` or `max-width: 100%` on root), a circular layout dependency occurs and Chrome collapses the popup window to a thin strip.
- **Why 320px popup reflow is unsupported**: Root elements (`html, body, #app`) specify `width: 380px; min-width: 380px;` so Chrome allocates a fixed 380px popup bubble. `max-width: 100%` on inner child `.xmd-popup` cannot shrink below its ancestor's 380px minimum. Responsive 320px reflow applies to the Options page (`options.html`), while the Action Popup stays fixed at 380px for bubble safety.

### C. Label in Name (WCAG 2.5.3)
- **Why the old code was wrong**: Controls had visual labels (such as "Hover quick grab", "Upload media to cloud", "Sync secret (required)") linked via `<FieldLabel htmlFor="id">`, but also carried different `aria-label` attributes (such as `"Quick Grab"`, `"Cloud upload"`, `"Convex sync secret"`). Under accessibility specifications, `aria-label` overrides the visual text in the accessible name calculation. Speech control users saying "Click Upload media to cloud" experienced failures because the programmatic name was "Cloud upload".
- **Why the new code is correct**: Removing the conflicting `aria-label` attributes allows the browser to compute accessible names directly from visual `<FieldLabel htmlFor="...">` elements. The programmatic accessible name now matches the visible text exactly across all panel controls.

---

## 3. Why Junior Developers Make These Errors

1. **Visual Bias & Subtree Swapping**: Junior developers often test software solely by visual inspection. Returning a `<div>` in one state and a `Fragment` in another looks identical visually, but destroys DOM node persistence required by accessibility APIs.
2. **Testing Environment Mismatch**: Junior developers test popup pages by opening `popup.html` directly in a browser tab. Standard browser tabs have fixed window dimensions where `100vw` equals screen width, hiding extension popup window collapse bugs.
3. **Redundant ARIA Attributes**: Junior developers frequently add `aria-label` to every control without realizing that `<label htmlFor="...">` already provides the accessible name, or that mismatched strings violate WCAG 2.5.3 speech navigation rules.

---

## 4. Best Practices Checklist

- **Keep live regions persistent across state transitions**: Place `<output aria-live="polite" aria-atomic="true">` outside state-based component branches under a top-level Fragment so React DOM reconciliation retains the same DOM element.
- **Respect HTML content models**: Do not place block-level elements (`<p>`, `<div>`) inside phrasing elements (`<output>`).
- **Fix root dimensions for extension popups**: Use explicit pixel dimensions (`width: 380px; min-width: 380px;`) on `html, body` for extension action popups to avoid bubble collapse.
- **Match visible labels to accessible names**: Rely on `<label htmlFor="...">` for form controls. Do not override visual text with different `aria-label` strings.
- **Verify in real target environments**: Test extension popups inside actual extension popup frames via CDP (`--cdp 9222`) rather than in browser tabs.
