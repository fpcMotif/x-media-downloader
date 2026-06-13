# Task 010: Popup Download history section + toggle + Clear history — impl

**Type:** impl
**depends-on:** ["009", "008"]
**Files:**
- `src/entrypoints/popup/history-section.ts` (create — pure helpers from task 009)
- `src/entrypoints/popup/App.tsx` (modify — add the "Download history" `<Section>`)

## Objective
Make task 009's tests pass (Green) and render the durable history in the popup: a "Download history" `<Section>` carrying the `downloadHistoryEnabled` toggle, the grouped record list (when on), and a "Clear history" action. OUT of scope: any `backend/` change; the live Monitor section is untouched.

## Contract (signatures & types ONLY)
```ts
// history-section.ts: groupByAuthor, formatRecord, historyEmptyLabel (per task 009)

// App.tsx (within the component): fetch records via the background message
//   const records = (await browser.runtime.sendMessage({ _tag: 'HistoryRequest' }))?.records ?? []
//   const clearHistory = async () => { await browser.runtime.sendMessage({ _tag: 'ClearHistoryRequest' }) ... }
```

## BDD Scenarios
```gherkin
Scenario: 009's helper scenarios pass
  Given history-section.ts implements the contract
  When task 009's suite runs
  Then it passes (Green)

Scenario: The toggle gates capture and is default off
  Given a fresh install
  Then the "Keep download history" checkbox is unchecked (downloadHistoryEnabled false)
  When the user enables it
  Then update({ downloadHistoryEnabled: true }) is dispatched

Scenario: History renders when enabled and present
  Given downloadHistoryEnabled true and stored records
  When the popup opens and HistoryRequest resolves
  Then records are listed grouped by author, each showing status, original link, filename, time

Scenario: Empty/disabled states
  Given the toggle off → the section shows the "turn on" prompt and no list
  Given the toggle on with no records → the section shows "No downloads yet"

Scenario: Clear history is separate from Clear monitor
  Given a populated history and an active download
  When the user clicks "Clear history"
  Then ClearHistoryRequest is sent and the list empties
  And the live Download monitor / active downloads are unaffected
```

## Steps
1. Create `history-section.ts` implementing task 009's helpers.
2. In `App.tsx`, add a new `<Section title="Download history" ...>` after the existing sections, with: a `xmd-check-row` toggle bound to `settings.downloadHistoryEnabled` via `update(...)`; a list built from `groupByAuthor(records)` + `formatRecord`; the `historyEmptyLabel` state text; and a "Clear history" button distinct from "Clear monitor".
3. Fetch records on open via `HistoryRequest`; refresh after `ClearHistoryRequest`.
4. Use existing `xmd-*` components (`Section`, `Field`, `xmd-check-row`, `xmd-inline-success`); do not introduce a new design system.

## Verification
- `bun run test src/entrypoints/popup/history-section.test.ts` — passes (Green).
- `bun run check` green (incl. `popup-layout.test.ts`).
- `bun run build` green.

## Notes
- PRODUCT.md: keep safe resets (Clear history) visually and behaviourally separate from anything that could imply cancelling downloads or deleting files.
- The history list reads the LOCAL store; it works with Cloud Sync off (no cloud dependency).
