# Lesson 0007: Accessibility Live Regions, Root Sizing, and WCAG 2.5.3

**Date:** 2026-08-03
**Category:** Accessibility (a11y) & UI Architecture

---

## 1. Summary of Changes

### HTML and Component Architecture
- **Live Regions (`<output>`)**: Replaced conditional `<div aria-live="polite">` and `<p aria-live="polite">` containers with continuously mounted `<output aria-live="polite" aria-atomic="true">` elements across `App.tsx`, `archive.tsx`, `release.tsx`, `capture-quick-actions.tsx`, and `confirm-strip.tsx`.
- **Phrasing Content Validity**: Removed block-level `<FieldDescription>` (`<p>`) tags from inside `<output>` containers. Placed plain text or `<span>` nodes inside `<output>`.
- **Label Matching (WCAG 2.5.3)**: Removed redundant `aria-label` overrides on controls in `saving.tsx`, `capture.tsx`, `history.tsx`, `release.tsx`, and `sync.tsx` where `<FieldLabel htmlFor="...">` already links the visual label to the control ID.

### CSS and Responsive Sizing
- **Bubble-Safe Sizing**: Re-established explicit `width: 380px; min-width: 380px;` rules on root elements (`html, body, #app`) in `src/app.css` and `src/entrypoints/popup/index.html`.
- **Inner Container Reflow**: Maintained `max-width: 100%; box-sizing: border-box;` on `.xmd-popup` to allow 320px content reflow without breaking Chrome popup window measurement.
- **Options Layout**: Added responsive breakpoint classes (`flex-col sm:flex-row`) in `src/entrypoints/options/App.tsx` so sidebar and main panels stack cleanly on narrow viewports without horizontal scrolling.

---

## 2. Technical Analysis for Beginners

### A. Live Region Announcements
- **Why the old code was wrong**: The previous code mounted `<div aria-live="polite">` only when `saved` or `statusMsg` became true. When a live region and its text enter the DOM simultaneously, screen readers do not register a change event inside an existing region and often skip speech output.
- **Why the new code is correct**: The `<output>` container remains in the DOM continuously from page load. Only the inner text updates from empty to non-empty (`{statusMsg}`). Screen readers detect the text insertion inside the persistent live region and reliably announce the update.
- **HTML semantics**: HTML rules prohibit block elements (`<p>`, `<div>`) inside phrasing elements (`<output>`). Replacing `<p>` with `<span>` or direct text node children ensures valid HTML parsing.

### B. Chrome Extension Action Popup Sizing
- **Why the old code was wrong**: The old code used `width: min(380px, 100vw)` or `max-width: 100%` directly on `html, body`. When Chrome opens an extension action popup bubble, it measures the un-sized iframe container. If the root element width depends on container percentages (`100vw` or `100%`), a circular layout dependency occurs and Chrome collapses the popup window to a thin strip.
- **Why the new code is correct**: Root elements (`html, body, #app`) specify `width: 380px; min-width: 380px;`. Chrome reads these explicit pixel values and allocates a 380px popup bubble. Inner containers (`.xmd-popup`) use `max-width: 100%;` so content reflows down to 320px when rendered in narrower frames.

### C. Label in Name (WCAG 2.5.3)
- **Why the old code was wrong**: Controls had visual labels (such as "Hover quick grab") linked via `<FieldLabel htmlFor="id">`, but also carried different `aria-label="Quick Grab"` attributes. Under accessibility specifications, `aria-label` overrides the visual text in the accessible name calculation. Speech control users saying "Click Hover quick grab" experienced failures because the programmatic name was "Quick Grab".
- **Why the new code is correct**: Removing the conflicting `aria-label` allows the browser to compute the accessible name directly from the visual `<FieldLabel>`. The programmatic accessible name now matches the visible text exactly.

---

## 3. Why Junior Developers Make These Errors

1. **Visual Bias**: Junior developers often test software solely by visual inspection. Toggling CSS opacity (`opacity-0` to `opacity-100`) makes text appear visually, leading developers to assume screen readers announce it. Screen readers track DOM text nodes, not CSS opacity transitions.
2. **Testing Environment Mismatch**: Junior developers test popup pages by opening `popup.html` directly in a browser tab. Standard browser tabs have fixed window dimensions where `100vw` equals screen width, hiding extension popup window collapse bugs.
3. **Redundant ARIA Attributes**: Junior developers frequently add `aria-label` to every control without realizing that `<label htmlFor="...">` already provides the accessible name, or that mismatched strings violate speech navigation rules.

---

## 4. Best Practices Checklist

- **Keep live regions persistent**: Mount `<output aria-live="polite" aria-atomic="true">` on initial render; update only its inner text content.
- **Respect HTML content models**: Do not place block-level elements (`<p>`, `<div>`) inside phrasing elements (`<output>`).
- **Fix root dimensions for extension popups**: Use explicit pixel dimensions (`width: 380px; min-width: 380px;`) on `html, body` for extension action popups.
- **Match visible labels to accessible names**: Rely on `<label htmlFor="...">` for form controls. Do not override visual text with different `aria-label` strings.
- **Verify in real target environments**: Test extension popups inside actual extension popup frames via CDP (`--cdp 9222`) rather than in browser tabs.
