# Lesson 0007: Accessibility Live Regions, Fixed Action Popup Sizing, and WCAG 2.5.3

**Date:** 2026-08-03
**Category:** Accessibility (a11y) & UI Architecture

---

## 1. Important Terms for Beginners

Before you read this lesson, learn these five key terms:

- **DOM (Document Object Model):** The tree of elements (buttons, text, inputs) that the browser creates to render a web page.
- **Live Region:** An HTML element with `aria-live` that tells screen readers to announce new text aloud when it appears.
- **ARIA (Accessible Rich Internet Applications):** Attributes that give screen readers extra information about web elements.
- **WCAG (Web Content Accessibility Guidelines):** The official international standards for accessible software design.
- **Reconciliation:** The process React uses to compare old and new components and decide which DOM elements to keep, update, or remove.

---

## 2. Summary of Changes

### A. Live Region Fixes (`<output>`)
- **Cause:** Live regions were created only when messages appeared.
- **Problem:** Screen readers did not announce the text because the live region was not already in the DOM.
- **Fix:** Keep one `<output aria-live="polite" aria-atomic="true">` element in the DOM at all times. Update only its inner text.
- **Result:** Screen readers announce every status message correctly.

### B. Valid HTML Inside Output Elements
- **Cause:** Paragraph tags (`<p>`) were placed inside `<output>` elements.
- **Problem:** HTML rules do not allow paragraph tags inside output tags.
- **Fix:** Replace paragraph tags with text or `<span>` elements.
- **Result:** The web page uses clean, valid HTML.

### C. Persistent Output Nodes in ConfirmStrip and CaptureQuickActions
- **Cause:** `ConfirmStrip` returned a Fragment (`<>`) when idle and a `<div>` when active. `CaptureQuickActions` placed its status `<output>` inside the `{open && (...)}` disclosure conditional.
- **Problem:** React reconciliation destroyed the old DOM node and created a new one when components switched states or collapsed. The live region was lost during disclosure toggles.
- **Fix:** Move the `<output key="confirm-strip-output">` element in `ConfirmStrip` to the top level outside the condition. Move the status `<output>` in `CaptureQuickActions` outside the `open` conditional into its root container.
- **Result:** React keeps the `<output>` element mounted in `ConfirmStrip` across idle and armed states, and in `CaptureQuickActions` across disclosure open/close states and while status flashes are active.

### D. Label Matching (WCAG 2.5.3)
- **Cause:** Form controls had custom `aria-label` attributes that differed from their visible labels.
- **Problem:** Speech software failed when users spoke the visible label text.
- **Fix:** Remove `aria-label` overrides when `<label htmlFor="...">` already connects the visible label to the control ID.
- **Result:** The programmatic name matches the visible label text exactly.

### E. Fixed Popup Sizing and Options Reflow
- **Cause:** Extension popup windows need explicit pixel dimensions to open correctly.
- **Problem:** Using percentage widths on root elements causes Chrome popup bubbles to collapse.
- **Fix:** Keep `width: 380px; min-width: 380px;` on root elements for popup windows. Add responsive flex classes to the Options page.
- **Result:** Popup windows remain stable at 380px width, while the Options page reflows on small screens down to 320px.

---

## 3. Understandable Misconceptions by Junior Developers

1. **Testing only by visual inspection:**
   A developer might toggle CSS opacity (`opacity-0` to `opacity-100`) to show text. The text appears on screen, so the developer assumes screen readers announce it. Screen readers track DOM text changes, not CSS opacity.

2. **Testing popups in browser tabs:**
   A developer might test `popup.html` by opening it in a regular browser tab. Standard tabs have wide viewports, which hides bugs that collapse extension popup windows.

3. **Overusing ARIA attributes:**
   A developer might add `aria-label` to every input control. If the `aria-label` text differs from the visual label, it breaks speech recognition tools.

---

## 4. Best Practices Checklist

- **Keep live regions persistent:** Mount `<output aria-live="polite" aria-atomic="true">` on initial render outside conditional branches. Change only its text.
- **Use valid HTML nesting:** Do not place block elements (`<p>`, `<div>`) inside `<output>` tags.
- **Preserve React DOM nodes:** Keep live regions outside conditional disclosure branches (`open`, `armedAt`) so React reconciliation retains the DOM node across state transitions.
- **Match visible labels to accessible names:** Rely on `<label htmlFor="...">` for form inputs. Do not override visual text with different `aria-label` strings.
- **Test in real extension popups:** Verify popup behavior in real extension popup windows via CDP (`--cdp 9222`), not in browser tabs.
